import { open, realpath, stat } from "node:fs/promises";
import { collectLocalTypes, collectPackageTypes, type TypesFs } from "@jslab/npm";
import type { LocalTypesResult, PackageTypesResult } from "@jslab/rpc-schema";

const MAX_TYPE_FILE_BYTES = 5 * 1024 * 1024;

/**
 * Reads only regular files; a file over 5 MB is skipped (its package reports truncated). Opens the path once and
 * fstats and reads that same handle (R-M3-T13-FIX-1 M-2), so the size that was checked is the size that gets read,
 * and a path swapped to a symlink after the check can't redirect the read.
 */
export const nodeTypesFs: TypesFs = {
  async readText(path) {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(path, "r");
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_TYPE_FILE_BYTES) return null;
      const buffer = Buffer.alloc(info.size);
      let read = 0;
      while (read < buffer.length) {
        const { bytesRead } = await handle.read(buffer, read, buffer.length - read, read);
        if (bytesRead === 0) break;
        read += bytesRead;
      }
      return buffer.subarray(0, read).toString("utf8");
    } catch {
      return null;
    } finally {
      await handle?.close();
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
