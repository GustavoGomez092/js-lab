import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "../persistence/atomic-write";

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
 *
 * Fix round 1 (C1, I1): one `VendorCache` instance is shared process-wide (`main-services.ts`), and Task 7 drives
 * it from concurrent per-tab bundles, so two kinds of concurrent access have to be safe, not just single-threaded
 * use:
 * - **Same key, concurrent `set()`/`get()`** (e.g. two tabs with identical imports and the same `bun.lock`): each
 *   file is published via `writeFileAtomic` (temp file + fsync + rename -- the same utility every other on-disk
 *   store in this app already uses), so a reader can never see a torn file. That alone isn't enough to stop a
 *   *mismatched pair* (a rename of `.js` landing between another `get()`'s two reads, pairing new code with a
 *   stale or absent map) -- for that, every `get()`/`set()` for the *same key* is additionally serialized through
 *   `#exclusive`, a per-key promise chain, so a read for a key can never run while a write for that same key is
 *   between its two file publishes. Different keys never block each other: `#exclusive` only queues operations
 *   that share a key, which is what keeps ordinary multi-tab use (distinct import sets almost always mean distinct
 *   keys) fully parallel.
 * - **Different keys, concurrent `set()`** (the ordinary multi-tab case: many tabs, many distinct keys, one shared
 *   `index.json`): the index's read-modify-write is serialized process-wide through `#withIndex`, a single promise
 *   queue whose critical section is kept to exactly the read, the caller's in-memory mutation, and the write --
 *   the slow parts (writing the `.js`/`.js.map` files themselves, deleting evicted files) happen outside it.
 *
 * Fix round 2 (I2, M2): `#exclusive`/`#withIndex` alone don't cover *eviction's* physical file deletion or
 * `invalidateAll`'s directory wipe, both of which touch files/index state outside a `set()`/`get()` call's own key.
 * `#evict` excludes the key it's running on behalf of from its own candidates (that key was just published, so
 * it's also the worst eviction target) and never awaits another key's deletion -- see `#evict` and
 * `#deleteIfStillAbsent` for why awaiting it would risk a cross-key deadlock. `invalidateAll` drains in-flight
 * per-key work before wiping, then wipes as one step inside `#withIndex` -- see `invalidateAll`.
 */
export class VendorCache {
  /** Fix round 1 (I1): the single process-wide queue every `index.json` read-modify-write runs through. */
  #indexQueue: Promise<void> = Promise.resolve();
  /** Fix round 1 (C1): one promise chain per key currently in flight; see `#exclusive`. */
  #keyLocks = new Map<string, Promise<void>>();
  /** Fix round 2 (I2): eviction's background per-key deletions currently in flight; see `#evict`, `waitIdle`. */
  #pendingEvictions = new Set<Promise<void>>();

  constructor(private readonly deps: VendorCacheDeps) {}

  /**
   * Fix round 2 (I2): resolves once every eviction cleanup that had already started by the time this was called
   * has settled. `set()`/`get()` never wait on this themselves (see `#evict`'s doc comment for why that would risk
   * a cross-key deadlock), so without this there would be no way to observe -- from a test, or from any future
   * caller that cares, such as a clean shutdown -- that background cleanup has actually finished; the index is
   * already fully consistent the instant `set()`/`get()`/`invalidateAll()` resolve regardless, since eviction's
   * *decision* is always durably recorded before this method's cleanup work even starts.
   */
  async waitIdle(): Promise<void> {
    await Promise.all([...this.#pendingEvictions]);
  }

  /** A cache hit reads both files; a miss (absent, or past `VENDOR_CACHE_MAX_AGE_MS`) returns null and evicts it. */
  get(key: string): Promise<VendorChunk | null> {
    return this.#exclusive(key, () => this.#doGet(key));
  }

  /** Writes both files, then evicts anything past the age limit or, after that, past the total size limit. */
  set(key: string, chunk: VendorChunk): Promise<void> {
    return this.#exclusive(key, () => this.#doSet(key, chunk));
  }

  /**
   * Spec §11.3: joined into the existing npm-change path (`main-services.ts`'s `NpmService.afterChange`, alongside
   * `spares.invalidateAll()` and `types.invalidate()`) so every cached vendor chunk is dropped after any npm change,
   * not just the ones whose key happens to have gone stale.
   *
   * Fix round 2 (M2): first waits for whatever `get()`/`set()` calls are already in flight (a snapshot of
   * `#keyLocks` taken right now -- their stored chains never reject, so nothing here can throw), so the wipe never
   * lands mid-write and turns an in-flight `writeFileAtomic`/`readIndex` into a real rejection for that caller. The
   * actual `rm()` then runs as one step inside `#withIndex`, the same queue every other index mutation goes
   * through, so it can't interleave with a concurrent index read/write either. A brand-new `set()`/`get()` issued
   * *after* this snapshot isn't blocked -- it just runs against a freshly-empty cache, which is a clean outcome,
   * not a race.
   */
  async invalidateAll(): Promise<void> {
    await Promise.all([...this.#keyLocks.values()]);
    await this.#withIndex(
      async () => {
        await rm(this.deps.cacheDir, { recursive: true, force: true });
      },
      { persist: false },
    );
  }

  async #doGet(key: string): Promise<VendorChunk | null> {
    const entry = await this.#withIndex((index) => index[key], { persist: false });
    if (!entry) return null;
    if (this.#now() - entry.writtenAt > this.#maxAgeMs()) {
      await this.#removeEntry(key);
      await this.#withIndex((index) => {
        delete index[key];
      });
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
      await this.#withIndex((index) => {
        delete index[key];
      });
      return null;
    }
  }

  /**
   * Fix round 1 (C1): each file is published through `writeFileAtomic` (temp file in the same directory, fsync,
   * then rename -- rename is atomic on the same filesystem, so a reader can never observe a torn file for either
   * one on its own), and `writeFileAtomic` already removes its own temp file on failure. The two publishes run in
   * parallel since they're independent files with independent temp names; what makes the *pair* atomic from a
   * reader's perspective is that this whole call only ever runs inside `#exclusive(key, ...)` (see `set()`), so no
   * `get()` for this same key can observe the moment between the two renames.
   */
  async #doSet(key: string, chunk: VendorChunk): Promise<void> {
    await Promise.all([
      writeFileAtomic(this.#codePath(key), chunk.code),
      writeFileAtomic(this.#mapPath(key), chunk.map),
    ]);
    const size = Buffer.byteLength(chunk.code, "utf8") + Buffer.byteLength(chunk.map, "utf8");
    const writtenAt = this.#now();
    await this.#withIndex((index) => {
      index[key] = { size, writtenAt };
    });
    await this.#evict(key);
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
   * Fix round 1 (I1): every read-modify-write of `index.json` -- from `#doGet`'s stale/repair paths, `#doSet`'s
   * new-entry write, and `#evict`'s sweep -- goes through this single process-wide queue, so two callers can never
   * interleave a read and a write of the same `index.json` and silently drop each other's entry. The critical
   * section is exactly the read, `fn`'s in-memory mutation, and the write: no file I/O for the cache entries
   * themselves happens inside it, so an unrelated slow `.js`/`.js.map` write never blocks another key's index
   * update. `persist: false` skips the write-back for a pure lookup (`#doGet`'s common hit path), so an ordinary
   * cache hit costs one read of `index.json`, not a read plus a redundant rewrite. `fn` may be async (fix round 2,
   * M2: `invalidateAll`'s `rm()` runs as its own critical section this way, never overlapping another index op).
   */
  #withIndex<T>(fn: (index: VendorCacheIndex) => T | Promise<T>, options: { persist?: boolean } = {}): Promise<T> {
    const persist = options.persist ?? true;
    const run = this.#indexQueue.then(async () => {
      const index = await this.#readIndex();
      const result = await fn(index);
      if (persist) await this.#writeIndex(index);
      return result;
    });
    // The next queued index operation must run even if this one failed, or a single rejection would wedge every
    // later get()/set() on this cache forever; the real result or error for THIS call still flows through `run`.
    this.#indexQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Fix round 1 (C1): serializes every `get()`/`set()` call that shares `key` behind one promise chain, so a read
   * can never land between a concurrent write's two file publishes (the one race `writeFileAtomic` alone can't
   * close, since it only makes each file individually atomic, not the pair). Calls for different keys never wait
   * on each other -- the map holds one chain per key that currently has work queued, and is pruned once that
   * chain is idle, so it never grows to hold every key ever seen.
   */
  #exclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.#keyLocks.get(key) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const settled: Promise<void> = run.then(
      () => undefined,
      () => undefined,
    );
    this.#keyLocks.set(key, settled);
    settled.then(() => {
      if (this.#keyLocks.get(key) === settled) this.#keyLocks.delete(key);
    });
    return run;
  }

  /**
   * Age first (anything past `maxAgeMs`), then total size (oldest-write-first) until back under `maxTotalBytes`.
   * Runs after every `set()`, so eviction is amortized instead of needing its own scheduler. Deciding what to
   * evict is a pure in-memory step done inside `#withIndex`'s critical section; the actual file deletions run
   * afterward, outside it, so they never hold up another key's index update.
   *
   * Fix round 2 (I2): `excludeKey` is the key the caller (`#doSet`) is *currently* publishing under its own
   * `#exclusive` lock, and it is never a candidate here -- a key mid-write is also the freshest, least sensible
   * thing to evict, so excluding it costs nothing in cache behaviour (spec fix2, shape 1). Each *other* victim's
   * physical deletion is routed through that key's own `#exclusive` lock (`#deleteIfStillAbsent`) so it can never
   * race a concurrent `set()` for that same key -- but deliberately NOT awaited by this method: awaiting it would
   * make `#doSet` (already holding `excludeKey`'s lock) block on another key's lock queue, and if that key's own
   * concurrent `set()` is symmetrically mid-eviction and waiting on `excludeKey`'s lock, the two would deadlock
   * each other. Firing and forgetting removes that cycle entirely -- no `set()`/`get()` call's completion ever
   * depends on another key's lock queue, only on its own key's and the shared (non-nesting) index queue, so there
   * is no pair of calls that can wait on each other.
   */
  async #evict(excludeKey: string): Promise<void> {
    const now = this.#now();
    const maxAge = this.#maxAgeMs();
    const maxTotal = this.#maxTotalBytes();
    const toRemove = await this.#withIndex((index) => {
      const removed: string[] = [];
      for (const [key, entry] of Object.entries(index)) {
        if (key === excludeKey) continue;
        if (now - entry.writtenAt > maxAge) {
          removed.push(key);
          delete index[key];
        }
      }
      let total = Object.values(index).reduce((sum, entry) => sum + entry.size, 0);
      const byAge = Object.entries(index)
        .filter(([key]) => key !== excludeKey)
        .sort(([, a], [, b]) => a.writtenAt - b.writtenAt);
      for (const [key, entry] of byAge) {
        if (total <= maxTotal) break;
        removed.push(key);
        delete index[key];
        total -= entry.size;
      }
      return removed;
    });
    for (const key of toRemove) {
      const task = this.#exclusive(key, () => this.#deleteIfStillAbsent(key)).catch(() => {
        // Best-effort cleanup: a failure here (or losing this key's lock race, see #deleteIfStillAbsent) leaves a
        // phantom index-less file on disk a little longer than ideal, never a corrupt read -- the next eviction
        // pass, or a later `get()` for a genuinely different key, naturally retries reclaiming it.
      });
      this.#pendingEvictions.add(task);
      task.then(() => this.#pendingEvictions.delete(task));
    }
  }

  /**
   * Fix round 2 (I2): runs only once this key's `#exclusive` lock is actually held, which may be well after
   * `#evict`'s decision above -- a concurrent `set(key, ...)` that was already in flight when that decision was
   * made could have finished in the meantime and legitimately re-added `key` to the index. The re-check and the
   * physical delete both run *inside the same* `#withIndex` call (not a separate check followed by a separate
   * delete) so there is no window at all -- not even a single microtask -- between "the index still agrees `key`
   * is gone" and "the files are removed" for anything else to land in. A concurrent `set(key, ...)`'s own index
   * update can't run during that window either, since it goes through the same `#withIndex` queue; if that write
   * happens first, it wins the queue and re-adds `key` before this check ever sees it.
   */
  async #deleteIfStillAbsent(key: string): Promise<void> {
    await this.#withIndex(
      async (index) => {
        if (!(key in index)) await this.#removeEntry(key);
      },
      { persist: false },
    );
  }
}
