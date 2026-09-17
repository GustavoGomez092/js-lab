import { realpath, stat } from "node:fs/promises";
import { collectLocalTypes, collectPackageTypes, type TypesFs } from "@jslab/npm";
import type { LocalTypesResult, PackageTypesResult } from "@jslab/rpc-schema";
import { readBoundedTextOrNull } from "../fs/bounded-read";

const MAX_TYPE_FILE_BYTES = 5 * 1024 * 1024;

/**
 * Reads only regular files; a file over 5 MB is skipped, which the caller reports through its own `truncated` flag
 * — never silently treated as though the declaration didn't exist (R-M3-T13-FIX-3 N1). The open-fstat-read
 * sequence this used to carry inline is now `../fs/bounded-read`, shared with every other bounded read in Main:
 * it fstats the handle it will read (R-M3-T13-FIX-1 M-2) and opens with `O_NONBLOCK` (R-M3-T13-FIX-2 #3), so a
 * FIFO — for example a crafted `package.json` — returns null instead of blocking until a writer appears. `TypesFs`
 * is a best-effort probe interface, so every failure still collapses to null here.
 */
export const nodeTypesFs: TypesFs = {
  readText: (path) => readBoundedTextOrNull(path, MAX_TYPE_FILE_BYTES),
  async isFile(path) {
    try {
      return (await stat(path)).isFile();
    } catch {
      return false;
    }
  },
  async realpath(path) {
    try {
      return await realpath(path);
    } catch {
      // ENOENT, EINVAL and ELOOP all mean "can't resolve"; the caller treats null the same for any of them.
      return null;
    }
  },
};

export interface TypesServiceDeps {
  /** `[<WD>/node_modules, <packages>/node_modules]`, or just the packages folder without a WD (spec §5.3 order). */
  nodeModulesDirsFor(tabId: string): string[];
  workingDirectoryFor(tabId: string): string | null;
  fs?: TypesFs;
}

/** Caps the package cache between `invalidate()` calls (R-M3-T13-FIX-1 M-6). */
export const MAX_PACKAGE_TYPES_CACHE = 200;

/** Main's `npm/types` service (spec §6.2). */
export class TypesService {
  /** Insertion-ordered; a hit re-inserts its key so the map's front is always the least recently used. */
  readonly #cache = new Map<string, Promise<PackageTypesResult>>();

  constructor(private readonly deps: TypesServiceDeps) {}

  packages(tabId: string, names: readonly string[]): Promise<PackageTypesResult[]> {
    const dirs = this.deps.nodeModulesDirsFor(tabId);
    return Promise.all(
      names.map((name) => {
        const key = `${dirs.join("\n")}\n${name}`;
        const cached = this.#cache.get(key);
        if (cached) {
          this.#cache.delete(key);
          this.#cache.set(key, cached);
          return cached;
        }
        const entry = collectPackageTypes(this.deps.fs ?? nodeTypesFs, { name, nodeModulesDirs: dirs });
        this.#cache.set(key, entry);
        entry.catch(() => this.#cache.delete(key));
        if (this.#cache.size > MAX_PACKAGE_TYPES_CACHE) {
          const oldest = this.#cache.keys().next().value;
          if (oldest !== undefined) this.#cache.delete(oldest);
        }
        return entry;
      }),
    );
  }

  async local(tabId: string, specifiers: readonly string[]): Promise<LocalTypesResult> {
    const workingDirectory = this.deps.workingDirectoryFor(tabId);
    if (!workingDirectory) return { files: [], packages: [], truncated: false };
    return collectLocalTypes(this.deps.fs ?? nodeTypesFs, { workingDirectory, specifiers });
  }

  /** After any package change or WD change (spec §6.2, §11.3). */
  invalidate(): void {
    this.#cache.clear();
  }
}
