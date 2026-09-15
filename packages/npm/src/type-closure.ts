import { dirname, join, normalize, relative } from "node:path/posix";
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

async function firstFile(fs: TypesFs, candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) if (await fs.isFile(candidate)) return candidate;
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

async function readManifest(fs: TypesFs, dir: string): Promise<Record<string, unknown> | null> {
  const text = await fs.readText(join(dir, "package.json"));
  if (text === null) return null;
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function entryFiles(fs: TypesFs, dir: string, manifest: Record<string, unknown>): Promise<string[]> {
  const declared: string[] = [];
  for (const key of ["types", "typings"]) if (typeof manifest[key] === "string") declared.push(manifest[key] as string);
  typesConditions(manifest.exports, declared);
  if (declared.length === 0 && typeof manifest.main === "string") declared.push(manifest.main);
  if (declared.length === 0) declared.push("index.d.ts");
  const files: string[] = [];
  for (const entry of declared) {
    const found = await firstFile(fs, declarationCandidates(normalize(join(dir, entry))));
    if (found && !files.includes(found)) files.push(found);
  }
  return files;
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
  },
): Promise<{ files: TypeFile[]; bare: string[]; truncated: boolean }> {
  const files: TypeFile[] = [];
  const bare = new Set<string>();
  const seen = new Set<string>();
  const queue = [...input.roots];
  let bytes = 0;
  let truncated = false;
  const withinReal = (await fs.realpath(input.within)) ?? input.within;
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    if (!file.startsWith(`${input.within}/`)) continue;
    const real = await fs.realpath(file);
    if (real === null || !(real === withinReal || real.startsWith(`${withinReal}/`))) continue;
    const content = await fs.readText(file);
    if (content === null) continue;
    if (bytes + content.length > input.maxBytes || files.length >= input.maxFiles) {
      truncated = true;
      break;
    }
    bytes += content.length;
    files.push({ path: input.toPath(file), content });
    for (const match of content.matchAll(REFERENCE_PATH)) {
      const found = await firstFile(fs, declarationCandidates(normalize(join(dirname(file), match[1] as string))));
      if (found) queue.push(found);
    }
    for (const match of content.matchAll(REFERENCE_TYPES)) bare.add(match[1] as string);
    for (const specifier of specifiersIn(content)) {
      if (specifier.startsWith(".")) {
        const found = await firstFile(fs, input.resolve(file, specifier));
        if (found) queue.push(found);
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

  const locate = async (name: string) => {
    for (const modules of input.nodeModulesDirs) {
      const dir = join(modules, name);
      const manifest = await readManifest(fs, dir);
      if (manifest) return { dir, manifest, modules };
    }
    return null;
  };

  const collect = async (name: string, found: { dir: string; manifest: Record<string, unknown> }) => {
    const roots = await entryFiles(fs, found.dir, found.manifest);
    if (roots.length === 0) return null;
    const packageJson = join(found.dir, "package.json");
    const result = await closure(fs, {
      roots: [packageJson, ...roots],
      within: found.dir,
      toPath: (file) => `file:///node_modules/${name}/${relative(found.dir, file)}`,
      maxBytes,
      maxFiles: MAX_PACKAGE_TYPE_FILES,
      resolve: (from, specifier) => declarationCandidates(normalize(join(dirname(from), specifier))),
      ownName: name,
    });
    return result;
  };

  const own = await locate(input.name);
  if (!own) return empty(null);
  const ownTypes = await collect(input.name, own);
  if (ownTypes) {
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
  if (!typed) return empty(typesName);
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
  const roots: string[] = [];
  for (const specifier of input.specifiers) {
    const found = await firstFile(fs, localCandidates(normalize(join(wd, specifier))));
    if (found) roots.push(found);
  }
  const result = await closure(fs, {
    roots,
    within: wd,
    toPath: (file) => `file:///tab/${relative(wd, file)}`,
    maxBytes: input.maxBytes ?? MAX_PACKAGE_TYPES_BYTES,
    maxFiles: input.maxFiles ?? MAX_LOCAL_TYPE_FILES,
    resolve: (from, specifier) => localCandidates(normalize(join(dirname(from), specifier))),
    ownName: null,
  });
  return { files: result.files, packages: result.bare, truncated: result.truncated };
}
