import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import type { Plugin } from "vite";

type TypeFile = { path: string; content: string };
type Pack = "node" | "bun";

/** The pinned packages behind each runtime pack (spec §5.2, §6.2). `@types/node` imports `undici-types`. */
export const TYPE_LIB_PACKS: Record<Pack, readonly string[]> = {
  node: ["@types/node", "undici-types"],
  bun: ["bun-types"],
};

/** Both packs together stay below this many UTF-8 bytes of declaration source. */
export const MAX_TYPE_LIB_BYTES = 8_000_000;

/**
 * Monaco's bundled TypeScript `versionMajorMinor` (checked against
 * `esm/vs/languages/features/typescript/lib/typescriptServices.js` by a test). A package's `typesVersions` entries
 * are evaluated against this, so a Monaco bump that changes the bundled TypeScript version fails that test loudly
 * rather than silently reintroducing declarations meant for a different TypeScript version (R-M3-T23-FIX-1).
 */
export const BUNDLED_TYPESCRIPT_VERSION = "5.9";

const RANGE = /^(>=|>|<=|<)?\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?$/;

/**
 * A minimal `typesVersions` range matcher (R-M3-T23-FIX-1): `*`; a comparator (`>=`, `>`, `<=`, `<`) followed by
 * `MAJOR`, `MAJOR.MINOR` or `MAJOR.MINOR.PATCH`; or a bare `MAJOR.MINOR`, which means equal major and minor. A
 * missing minor or patch counts as 0. Anything else (`||`, two comparators, `~`/`^`, …) throws.
 */
export function typesVersionsRangeMatches(range: string, version: string): boolean {
  const trimmed = range.trim();
  if (trimmed === "*") return true;
  const match = RANGE.exec(trimmed);
  if (!match) throw new Error(`Unsupported typesVersions range "${range}"`);
  const [, comparator, majorStr, minorStr, patchStr] = match;
  const target = { major: Number(majorStr), minor: Number(minorStr ?? 0), patch: Number(patchStr ?? 0) };
  const [vMajor, vMinor, vPatch] = version.trim().split(".");
  const actual = { major: Number(vMajor ?? 0), minor: Number(vMinor ?? 0), patch: Number(vPatch ?? 0) };
  if (!comparator) {
    if (minorStr === undefined || patchStr !== undefined) {
      throw new Error(`Unsupported typesVersions range "${range}"`);
    }
    return actual.major === target.major && actual.minor === target.minor;
  }
  const cmp = actual.major - target.major || actual.minor - target.minor || actual.patch - target.patch;
  switch (comparator) {
    case ">=":
      return cmp >= 0;
    case ">":
      return cmp > 0;
    case "<=":
      return cmp <= 0;
    default:
      return cmp < 0;
  }
}

export function resolvePackageDir(name: string, fromDir: string): string {
  return dirname(createRequire(join(fromDir, "package.json")).resolve(`${name}/package.json`));
}

/** Collects files under `dir`, skipping nested `node_modules` and never following symlinks out of the package. */
function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || entry.name === "node_modules") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (entry.name.endsWith(".d.ts") || path === join(dir, "package.json")) out.push(path);
  }
}

/**
 * The package's `typesVersions` mapping targets that redirect a TypeScript version other than
 * `BUNDLED_TYPESCRIPT_VERSION`, as directory names relative to `pkg.dir` (R-M3-T23-FIX-1). Throws if any range
 * matches the bundled version, since the pack doesn't support redirected declarations yet (spec §6.2 risk: Monaco's
 * TypeScript misparses newer-syntax declarations it was never meant to see, per Task 23 fix round 1).
 */
function excludedDirsFor(pkg: { name: string; dir: string }): string[] {
  const manifest = JSON.parse(readFileSync(join(pkg.dir, "package.json"), "utf8")) as {
    typesVersions?: Record<string, Record<string, string[]>>;
  };
  const typesVersions = manifest.typesVersions;
  if (!typesVersions) return [];
  const excluded = new Set<string>();
  for (const [range, mapping] of Object.entries(typesVersions)) {
    if (typesVersionsRangeMatches(range, BUNDLED_TYPESCRIPT_VERSION)) {
      throw new Error(
        `Type library ${pkg.name} has a typesVersions entry "${range}" for TypeScript ${BUNDLED_TYPESCRIPT_VERSION}; the pack does not support redirected declarations yet`,
      );
    }
    for (const targets of Object.values(mapping)) {
      for (const target of targets) {
        const slash = target.indexOf("/");
        if (slash !== -1) excluded.add(target.slice(0, slash));
      }
    }
  }
  return [...excluded];
}

/** Every `.d.ts` and the package.json of each package, at `file:///node_modules/<name>/<path>`. */
export function collectTypeLibPack(packages: readonly { name: string; dir: string }[]): TypeFile[] {
  const files: TypeFile[] = [];
  for (const pkg of packages) {
    const excludedDirs = excludedDirsFor(pkg).map((dir) => join(pkg.dir, dir));
    const paths: string[] = [join(pkg.dir, "package.json")];
    walk(pkg.dir, paths);
    for (const path of [...new Set(paths)].sort()) {
      if (path !== join(pkg.dir, "package.json") && !path.endsWith(".d.ts")) continue;
      if (excludedDirs.some((dir) => path === dir || path.startsWith(`${dir}/`))) continue;
      files.push({
        path: `file:///node_modules/${pkg.name}/${relative(pkg.dir, path)}`,
        content: readFileSync(path, "utf8"),
      });
    }
  }
  return files;
}

const PREFIX = "virtual:jslab-type-libs/";
/** Rollup's virtual-module marker: a resolved id that starts with a NUL byte. */
const NUL = String.fromCharCode(0);

/** Serves `virtual:jslab-type-libs/<pack>` as `export default [...]`; a dynamic import becomes its own chunk. */
export function jslabTypeLibs(root: string = join(import.meta.dirname, "..")): Plugin {
  return {
    name: "jslab-type-libs",
    resolveId(id: string) {
      return id.startsWith(PREFIX) ? `${NUL}${id}` : null;
    },
    load(id: string) {
      if (!id.startsWith(`${NUL}${PREFIX}`)) return null;
      const pack = id.slice(PREFIX.length + 1);
      // Own keys only: an inherited name such as "constructor" is not a pack.
      if (!Object.hasOwn(TYPE_LIB_PACKS, pack)) return null;
      const names = TYPE_LIB_PACKS[pack as Pack];
      return `export default ${JSON.stringify(collectTypeLibPack(names.map((name) => ({ name, dir: resolvePackageDir(name, root) }))))};`;
    },
  };
}
