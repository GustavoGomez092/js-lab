import { readFile, realpath, stat } from "node:fs/promises";
import { collectLocalTypes, collectPackageTypes, type TypesFs } from "@jslab/npm";
import type { LocalTypesResult, PackageTypesResult } from "@jslab/rpc-schema";

/** Reads only regular files; a file over 5 MB is skipped (its package reports truncated). */
export const nodeTypesFs: TypesFs = {
  async readText(path) {
    try {
      const info = await stat(path);
      if (!info.isFile() || info.size > 5 * 1024 * 1024) return null;
      return await readFile(path, "utf8");
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

/** Main's `npm/types` service (spec §6.2). */
export class TypesService {
  readonly #cache = new Map<string, Promise<PackageTypesResult>>();

  constructor(private readonly deps: TypesServiceDeps) {}

  packages(tabId: string, names: readonly string[]): Promise<PackageTypesResult[]> {
    const dirs = this.deps.nodeModulesDirsFor(tabId);
    return Promise.all(
      names.map((name) => {
        const key = `${dirs.join("\n")}\n${name}`;
        let entry = this.#cache.get(key);
        if (!entry) {
          entry = collectPackageTypes(this.deps.fs ?? nodeTypesFs, { name, nodeModulesDirs: dirs });
          this.#cache.set(key, entry);
          entry.catch(() => this.#cache.delete(key));
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
