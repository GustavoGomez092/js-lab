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

/** Every `.d.ts` and the package.json of each package, at `file:///node_modules/<name>/<path>`. */
export function collectTypeLibPack(packages: readonly { name: string; dir: string }[]): TypeFile[] {
  const files: TypeFile[] = [];
  for (const pkg of packages) {
    const paths: string[] = [join(pkg.dir, "package.json")];
    walk(pkg.dir, paths);
    for (const path of [...new Set(paths)].sort()) {
      if (path !== join(pkg.dir, "package.json") && !path.endsWith(".d.ts")) continue;
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
