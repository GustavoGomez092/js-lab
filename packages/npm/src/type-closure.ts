import { dirname, isAbsolute, join, normalize, relative } from "node:path/posix";
import type { LocalTypesResult, PackageTypesResult, TypeFile } from "@jslab/rpc-schema";
import { packageNameFromSpecifier, typesPackageName } from "./specifiers";

export interface TypesFs {
  readText(path: string): Promise<string | null>;
  isFile(path: string): Promise<boolean>;
  /** Resolves symlinks; null if the path doesn't exist or can't be resolved. */
  realpath(path: string): Promise<string | null>;
}

export const MAX_PACKAGE_TYPES_BYTES = 5 * 1024 * 1024;
export const MAX_LOCAL_TYPE_FILES = 200;
export const MAX_PACKAGE_TYPE_FILES = 2000;
/** Probe (`isFile`) budget per closure, independent of the file cap (R-M3-T13-FIX-1 I-1). */
const PROBE_BUDGET_PER_FILE = 16;
/** Manifest-declared entries (`types`/`typings`/`exports`/`main`) probed per package, deduped first (R-M3-T13-FIX-2 #1). */
export const MAX_DECLARED_TYPE_ENTRIES = 64;

const encoder = new TextEncoder();

const SPECIFIERS = [
  /\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  /^\s*import\s*["']([^"']+)["']/gm,
  /\bexport\s*\*\s*from\s*["']([^"']+)["']/g,
];
const REFERENCE_PATH = /\/\/\/\s*<reference\s+path\s*=\s*["']([^"']+)["']/g;
const REFERENCE_TYPES = /\/\/\/\s*<reference\s+types\s*=\s*["']([^"']+)["']/g;

function specifiersIn(text: string): string[] {
  const found = new Set<string>();
  for (const pattern of SPECIFIERS) for (const match of text.matchAll(pattern)) found.add(match[1] as string);
  return [...found];
}

/** True when `path` resolves, through symlinks, to `rootReal` or a path inside it (R-M3-T13-FIX-1 I-2). */
async function isInside(fs: TypesFs, rootReal: string, path: string): Promise<string | null> {
  const real = await fs.realpath(path);
  if (real === null) return null;
  return real === rootReal || real.startsWith(`${rootReal}/`) ? real : null;
}

/** Unbounded probe. Used only for a caller's own finite, explicitly-requested specifier list (never for candidates driven by scanned file content or an untrusted manifest — those share the budgeted `probeFile` below). */
async function firstFile(fs: TypesFs, candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) if (await fs.isFile(candidate)) return candidate;
  return null;
}

/** Budgeted, deduped probe shared by `closure()`'s walk and manifest-entry resolution, both driven by untrusted input. */
async function probeFile(
  fs: TypesFs,
  candidates: string[],
  cache: Map<string, boolean>,
  probes: { left: number },
): Promise<string | null> {
  for (const candidate of candidates) {
    let exists = cache.get(candidate);
    if (exists === undefined) {
      if (probes.left <= 0) return null;
      probes.left -= 1;
      exists = await fs.isFile(candidate);
      cache.set(candidate, exists);
    }
    if (exists) return candidate;
  }
  return null;
}

function declarationCandidates(base: string): string[] {
  if (/\.d\.[mc]?ts$/.test(base)) return [base];
  const js = /\.(m|c)?jsx?$/.exec(base);
  if (js) {
    const stem = base.slice(0, -js[0].length);
    const flavor = js[1] ?? "";
    return [`${stem}.d.${flavor}ts`, `${stem}.d.ts`];
  }
  return [`${base}.d.ts`, `${base}/index.d.ts`, `${base}.d.mts`, `${base}.d.cts`];
}

function typesConditions(value: unknown, out: string[]): void {
  if (typeof value !== "object" || value === null) return;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (key === "types" && typeof entry === "string") out.push(entry);
    else typesConditions(entry, out);
  }
}

/** Reads and parses `<dir>/package.json`, gated on the real path of both `dir` and the manifest file (I-2). */
async function readManifest(fs: TypesFs, dir: string): Promise<Record<string, unknown> | null> {
  const dirReal = await fs.realpath(dir);
  if (dirReal === null) return null;
  const real = await isInside(fs, dirReal, join(dir, "package.json"));
  if (real === null) return null;
  const text = await fs.readText(real);
  if (text === null) return null;
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Resolves `types`/`typings`/`exports`-condition/`main` entries to real files, all inside `dir` (#2), capped and
 * deduped before ever probing one (#1), sharing the caller's probe budget and cache.
 */
async function entryFiles(
  fs: TypesFs,
  dir: string,
  manifest: Record<string, unknown>,
  probeCache: Map<string, boolean>,
  probes: { left: number },
): Promise<{ files: string[]; truncated: boolean }> {
  const declared: string[] = [];
  for (const key of ["types", "typings"]) if (typeof manifest[key] === "string") declared.push(manifest[key] as string);
  typesConditions(manifest.exports, declared);
  if (declared.length === 0 && typeof manifest.main === "string") declared.push(manifest.main);
  if (declared.length === 0) declared.push("index.d.ts");

  // #1: dedupe on the normalized path and cap before any of them is ever probed.
  const seenBases = new Set<string>();
  const bases: string[] = [];
  for (const entry of declared) {
    const base = normalize(join(dir, entry));
    if (seenBases.has(base)) continue;
    seenBases.add(base);
    bases.push(base);
    if (bases.length >= MAX_DECLARED_TYPE_ENTRIES) break;
  }

  const files: string[] = [];
  let truncated = false;
  for (const base of bases) {
    // #2: an entry outside the package is never probed.
    if (!(base === dir || base.startsWith(`${dir}/`))) continue;
    const found = await probeFile(fs, declarationCandidates(base), probeCache, probes);
    if (probes.left <= 0) truncated = true;
    if (found && !files.includes(found)) files.push(found);
  }
  return { files, truncated };
}

async function closure(
  fs: TypesFs,
  input: {
    roots: string[];
    within: string;
    toPath: (file: string) => string;
    maxBytes: number;
    maxFiles: number;
    resolve: (from: string, specifier: string) => string[];
    ownName: string | null;
    probeCache: Map<string, boolean>;
    probes: { left: number };
  },
): Promise<{ files: TypeFile[]; bare: string[]; truncated: boolean }> {
  const files: TypeFile[] = [];
  const bare = new Set<string>();
  const seen = new Set<string>();
  const seenReal = new Set<string>();
  const { probeCache, probes } = input;
  const queue = [...input.roots];
  let bytes = 0;
  let truncated = false;

  // M-1: fail closed when the root itself can't be resolved, instead of falling back to the unresolved path.
  const withinReal = await fs.realpath(input.within);
  if (withinReal === null) return { files: [], bare: [], truncated: false };

  const insideLexically = (path: string) => path === input.within || path.startsWith(`${input.within}/`);

  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    if (!insideLexically(file)) continue;
    // M-2: read through the checked (`real`) path, not the unresolved candidate.
    const real = await isInside(fs, withinReal, file);
    if (real === null) continue;
    // M-3: two aliases of the same real file are read and returned once.
    if (seenReal.has(real)) continue;
    seenReal.add(real);
    const content = await fs.readText(real);
    if (content === null) continue;
    // M-4: count UTF-8 bytes, not UTF-16 code units.
    const size = encoder.encode(content).byteLength;
    if (bytes + size > input.maxBytes || files.length >= input.maxFiles) {
      truncated = true;
      break;
    }
    bytes += size;
    files.push({ path: input.toPath(file), content });

    // #5: exhausting the budget stops PROBING new candidates (`probeFile` no-ops once `probes.left` hits 0, free on
    // a cache hit), but never discards a candidate that already succeeded, and never skips scanning the rest of
    // this file's text for bare dependencies below, which cost no probes. The queue keeps draining afterward,
    // still gated by `isInside`, `seenReal` and the byte/file caps.
    for (const match of content.matchAll(REFERENCE_PATH)) {
      const candidates = declarationCandidates(normalize(join(dirname(file), match[1] as string))).filter(
        insideLexically,
      );
      const found = await probeFile(fs, candidates, probeCache, probes);
      if (found) queue.push(found);
      if (probes.left <= 0) truncated = true;
    }

    for (const match of content.matchAll(REFERENCE_TYPES)) {
      // I-3: a reference-types value is validated as a package name, and a package never lists itself.
      const name = packageNameFromSpecifier(match[1] as string);
      if (name && name !== input.ownName) bare.add(name);
    }

    for (const specifier of specifiersIn(content)) {
      if (specifier.startsWith(".")) {
        const candidates = input.resolve(file, specifier).filter(insideLexically);
        const found = await probeFile(fs, candidates, probeCache, probes);
        if (found) queue.push(found);
        if (probes.left <= 0) truncated = true;
        continue;
      }
      const name = packageNameFromSpecifier(specifier);
      if (name && name !== input.ownName) bare.add(name);
    }
  }
  return { files, bare: [...bare].sort(), truncated };
}

/** The `.d.ts` closure of one installed package (spec §6.2), registered at `file:///node_modules/<name>/…`. */
export async function collectPackageTypes(
  fs: TypesFs,
  input: { name: string; nodeModulesDirs: readonly string[]; maxBytes?: number },
): Promise<PackageTypesResult> {
  const maxBytes = input.maxBytes ?? MAX_PACKAGE_TYPES_BYTES;
  const empty = (typesPackage: string | null): PackageTypesResult => ({
    name: input.name,
    files: [],
    dependencies: [],
    typesPackage,
    hasTypes: false,
    truncated: false,
  });

  // I-3: refuse a `name` that isn't itself a valid package name (rejects `../other`, absolute paths, subpaths, `node:x`).
  if (packageNameFromSpecifier(input.name) !== input.name) return empty(null);

  // #1: one probe budget and cache for the whole call, shared by manifest-entry resolution and every closure it runs.
  const probeCache = new Map<string, boolean>();
  const probes = { left: MAX_PACKAGE_TYPE_FILES * PROBE_BUDGET_PER_FILE };

  const locate = async (name: string) => {
    for (const modules of input.nodeModulesDirs) {
      const dir = join(modules, name);
      const manifest = await readManifest(fs, dir);
      if (manifest) return { dir, manifest, modules };
    }
    return null;
  };

  type CollectResult = { files: TypeFile[]; bare: string[]; truncated: boolean };

  const collect = async (
    name: string,
    found: { dir: string; manifest: Record<string, unknown> },
  ): Promise<CollectResult | null> => {
    const entries = await entryFiles(fs, found.dir, found.manifest, probeCache, probes);
    if (entries.files.length === 0) return null;
    const packageJson = join(found.dir, "package.json");
    const result = await closure(fs, {
      roots: [packageJson, ...entries.files],
      within: found.dir,
      toPath: (file) => `file:///node_modules/${name}/${relative(found.dir, file)}`,
      maxBytes,
      maxFiles: MAX_PACKAGE_TYPE_FILES,
      resolve: (from, specifier) => declarationCandidates(normalize(join(dirname(from), specifier))),
      ownName: name,
      probeCache,
      probes,
    });
    return { ...result, truncated: result.truncated || entries.truncated };
  };

  // #2: `hasTypes` only when an actual declaration file (not just `package.json`) was read into `files`.
  const hasDeclarations = (result: CollectResult | null): result is CollectResult =>
    Boolean(result?.files.some((file) => !file.path.endsWith("/package.json")));

  const own = await locate(input.name);
  if (!own) return empty(null);
  const ownTypes = await collect(input.name, own);
  if (hasDeclarations(ownTypes)) {
    return {
      name: input.name,
      files: ownTypes.files,
      dependencies: ownTypes.bare,
      typesPackage: null,
      hasTypes: true,
      truncated: ownTypes.truncated,
    };
  }
  const typesName = typesPackageName(input.name);
  if (!typesName) return empty(null);
  const typesPkg = await locate(typesName);
  const typed = typesPkg ? await collect(typesName, typesPkg) : null;
  if (!hasDeclarations(typed)) return empty(typesName);
  return {
    name: input.name,
    files: typed.files,
    dependencies: typed.bare,
    typesPackage: typesName,
    hasTypes: true,
    truncated: typed.truncated,
  };
}

const LOCAL_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".d.ts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
  "/index.ts",
  "/index.js",
];

function localCandidates(base: string): string[] {
  if (/\.(?:[mc]?[jt]sx?|d\.ts)$/.test(base)) {
    const stem = base.replace(/\.[mc]?jsx?$/, "");
    return stem === base ? [base] : [`${stem}.ts`, `${stem}.tsx`, `${stem}.d.ts`, base];
  }
  return LOCAL_EXTENSIONS.map((extension) => `${base}${extension}`);
}

/** WD-local `.ts`/`.d.ts`/`.js` modules imported relatively (spec §6.2), registered at `file:///tab/<relative path>`. */
export async function collectLocalTypes(
  fs: TypesFs,
  input: { workingDirectory: string; specifiers: readonly string[]; maxFiles?: number; maxBytes?: number },
): Promise<LocalTypesResult> {
  const wd = normalize(input.workingDirectory).replace(/\/$/, "");
  // M-1: `/`, empty, or a WD that becomes empty after trimming slashes never walks the filesystem root.
  // #4: a relative WD would otherwise resolve against Main's cwd; only an absolute WD is honored.
  if (wd === "" || wd === "." || !isAbsolute(input.workingDirectory))
    return { files: [], packages: [], truncated: false };
  const roots: string[] = [];
  for (const specifier of input.specifiers) {
    const found = await firstFile(fs, localCandidates(normalize(join(wd, specifier))));
    if (found) roots.push(found);
  }
  const maxFiles = input.maxFiles ?? MAX_LOCAL_TYPE_FILES;
  const result = await closure(fs, {
    roots,
    within: wd,
    toPath: (file) => `file:///tab/${relative(wd, file)}`,
    maxBytes: input.maxBytes ?? MAX_PACKAGE_TYPES_BYTES,
    maxFiles,
    resolve: (from, specifier) => localCandidates(normalize(join(dirname(from), specifier))),
    ownName: null,
    probeCache: new Map<string, boolean>(),
    probes: { left: maxFiles * PROBE_BUDGET_PER_FILE },
  });
  return { files: result.files, packages: result.bare, truncated: result.truncated };
}
