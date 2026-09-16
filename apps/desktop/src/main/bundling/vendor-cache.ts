import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Spec §5.12/§11.3/§23: an entry the web runner hasn't rebuilt in longer than this is evicted even though its key
 * is still current -- a tab that never changes its imports could otherwise pin a chunk on disk forever. A week
 * comfortably outlives a normal working session while still reclaiming space from tabs the user has moved on from.
 */
export const VENDOR_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Spec §5.12/§11.3/§23: the vendor cache directory's total size cap. A React vendor chunk is on the order of a few
 * hundred KB; 200 MB holds many tabs' worth of distinct dependency sets with real headroom before eviction kicks in.
 */
export const VENDOR_CACHE_MAX_TOTAL_BYTES = 200 * 1024 * 1024;

export interface VendorChunk {
  code: string;
  map: string;
}

interface VendorCacheIndexEntry {
  size: number;
  writtenAt: number;
}

type VendorCacheIndex = Record<string, VendorCacheIndexEntry>;

/**
 * Keys a vendor chunk on the `bun.lock` hash (pins versions) plus the sorted import set (pins which packages this
 * bundle actually used) -- spec §5.12, exactly the two things `BundleResult` gives us (`bundler.ts`'s `imports`,
 * verbatim -- Task 5 made that set the truthful record of what actually got resolved into the bundle, and keying on
 * anything narrower or wider than it would risk serving a stale chunk after a changed dependency). Sorting first
 * means import order in the source file never changes the key.
 */
export function vendorCacheKey(lockHash: string, imports: readonly string[]): string {
  return String(Bun.hash(`${lockHash}\n${[...imports].sort().join("\n")}`));
}

/**
 * Spec §5.12: the lockfile-pinning half of the key. Hashed rather than used raw so the key stays a fixed-length,
 * filename-safe token regardless of how large `bun.lock` is.
 */
export function hashBunLock(lockContents: string): string {
  return String(Bun.hash(lockContents));
}

export interface VendorCacheDeps {
  /** `<appdata>/cache/vendor` (`apps/desktop/src/main/app-paths.ts`'s `vendorCacheDir`). */
  cacheDir: string;
  now?(): number;
  /** Test seam for `VENDOR_CACHE_MAX_AGE_MS`; production always uses the constant. */
  maxAgeMs?: number;
  /** Test seam for `VENDOR_CACHE_MAX_TOTAL_BYTES`; production always uses the constant. */
  maxTotalBytes?: number;
}

/**
 * The web runner's third-party chunk cache (spec §5.12, §11.3, §23): bundling a tab's code also bundles its
 * dependencies, and for something like React that's most of the work, so a re-run with an unchanged `bun.lock` and
 * import set reuses the chunk from disk instead of re-bundling.
 *
 * Each entry is the code and its source map, stored as sibling files under `cacheDir` (`<key>.js`, `<key>.js.map`),
 * plus one `index.json` recording each entry's size and write time -- tracked directly rather than re-derived from
 * filesystem `stat` so eviction is exact and deterministic under a fake clock in tests, instead of depending on
 * mtime precision.
 */
export class VendorCache {
  constructor(private readonly deps: VendorCacheDeps) {}

  /** A cache hit reads both files; a miss (absent, or past `VENDOR_CACHE_MAX_AGE_MS`) returns null and evicts it. */
  async get(key: string): Promise<VendorChunk | null> {
    const index = await this.#readIndex();
    const entry = index[key];
    if (!entry) return null;
    if (this.#now() - entry.writtenAt > this.#maxAgeMs()) {
      await this.#removeEntry(key);
      delete index[key];
      await this.#writeIndex(index);
      return null;
    }
    try {
      const [code, map] = await Promise.all([
        readFile(this.#codePath(key), "utf8"),
        readFile(this.#mapPath(key), "utf8"),
      ]);
      return { code, map };
    } catch {
      // The index and the files on disk disagree (e.g. a hand-cleared cache dir) -- treat it as a miss and repair
      // the index rather than trusting stale bookkeeping.
      delete index[key];
      await this.#writeIndex(index);
      return null;
    }
  }

  /** Writes both files, then evicts anything past the age limit or, after that, past the total size limit. */
  async set(key: string, chunk: VendorChunk): Promise<void> {
    await mkdir(this.deps.cacheDir, { recursive: true });
    await Promise.all([
      writeFile(this.#codePath(key), chunk.code, "utf8"),
      writeFile(this.#mapPath(key), chunk.map, "utf8"),
    ]);
    const index = await this.#readIndex();
    index[key] = {
      size: Buffer.byteLength(chunk.code, "utf8") + Buffer.byteLength(chunk.map, "utf8"),
      writtenAt: this.#now(),
    };
    await this.#evict(index);
  }

  /**
   * Spec §11.3: joined into the existing npm-change path (`main-services.ts`'s `NpmService.afterChange`, alongside
   * `spares.invalidateAll()` and `types.invalidate()`) so every cached vendor chunk is dropped after any npm change,
   * not just the ones whose key happens to have gone stale.
   */
  async invalidateAll(): Promise<void> {
    await rm(this.deps.cacheDir, { recursive: true, force: true });
  }

  #codePath(key: string): string {
    return join(this.deps.cacheDir, `${key}.js`);
  }

  #mapPath(key: string): string {
    return join(this.deps.cacheDir, `${key}.js.map`);
  }

  #indexPath(): string {
    return join(this.deps.cacheDir, "index.json");
  }

  #now(): number {
    return (this.deps.now ?? Date.now)();
  }

  #maxAgeMs(): number {
    return this.deps.maxAgeMs ?? VENDOR_CACHE_MAX_AGE_MS;
  }

  #maxTotalBytes(): number {
    return this.deps.maxTotalBytes ?? VENDOR_CACHE_MAX_TOTAL_BYTES;
  }

  async #readIndex(): Promise<VendorCacheIndex> {
    try {
      const raw = JSON.parse(await readFile(this.#indexPath(), "utf8"));
      return typeof raw === "object" && raw !== null ? (raw as VendorCacheIndex) : {};
    } catch {
      return {};
    }
  }

  async #writeIndex(index: VendorCacheIndex): Promise<void> {
    await mkdir(this.deps.cacheDir, { recursive: true });
    await writeFile(this.#indexPath(), JSON.stringify(index), "utf8");
  }

  async #removeEntry(key: string): Promise<void> {
    await Promise.all([rm(this.#codePath(key), { force: true }), rm(this.#mapPath(key), { force: true })]);
  }

  /**
   * Age first (anything past `maxAgeMs`), then total size (oldest-write-first) until back under `maxTotalBytes`.
   * Runs after every `set()`, so eviction is amortized instead of needing its own scheduler.
   */
  async #evict(index: VendorCacheIndex): Promise<void> {
    const now = this.#now();
    const maxAge = this.#maxAgeMs();
    for (const [key, entry] of Object.entries(index)) {
      if (now - entry.writtenAt > maxAge) {
        await this.#removeEntry(key);
        delete index[key];
      }
    }
    const maxTotal = this.#maxTotalBytes();
    let total = Object.values(index).reduce((sum, entry) => sum + entry.size, 0);
    const byAge = Object.entries(index).sort(([, a], [, b]) => a.writtenAt - b.writtenAt);
    for (const [key, entry] of byAge) {
      if (total <= maxTotal) break;
      await this.#removeEntry(key);
      delete index[key];
      total -= entry.size;
    }
    await this.#writeIndex(index);
  }
}
