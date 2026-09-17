import { realpath, stat } from "node:fs/promises";
import { collectLocalTypes, collectPackageTypes, type TypesFs } from "@jslab/npm";
import type { LocalTypesResult, PackageTypesResult } from "@jslab/rpc-schema";
import { MAX_NODE_MODULES_FILE_BYTES, readBoundedText } from "../files/bounded-read";

/**
 * Reads only regular files; a file over MAX_NODE_MODULES_FILE_BYTES is skipped, which the caller reports through
 * its own `truncated` flag — never silently treated as though the declaration didn't exist (R-M3-T13-FIX-3 N1).
 *
 * The open/fstat/refuse-then-allocate sequence this used to spell out inline is now `readBoundedText`
 * (`../files/bounded-read.ts`), which is the same algorithm with the same two load-bearing properties:
 * the size comes from the *opened handle* (R-M3-T13-FIX-1 M-2), so the size checked is the size read and a path
 * swapped to a symlink after the check cannot redirect it; and `O_NONBLOCK` (R-M3-T13-FIX-2 #3) means a FIFO — a
 * crafted `package.json`, say — is refused rather than blocking until a writer appears. Sharing the reader is the
 * point: two hand-written copies of a check whose *order* is the whole guarantee is how one of them gets reversed.
 *
 * The `null` contract is unchanged: this seam reports "nothing usable here" for every failure, so the refusals
 * `readBoundedText` throws are caught and flattened exactly like an ENOENT or an EACCES always were.
 */
export const nodeTypesFs: TypesFs = {
  async readText(path) {
    try {
      return await readBoundedText(path, MAX_NODE_MODULES_FILE_BYTES);
    } catch {
      return null;
    }
  },
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
