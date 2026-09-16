import { readdir, readFile, rm, stat } from "node:fs/promises";
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
 *
 * Fix round 3 (A1, A2, B1, B2, B3): four smaller gaps the first two rounds left open, all closed here:
 * - **A1**: `invalidateAll`'s drain only covers keys already registered at snapshot time -- see `#generation`.
 * - **A2**: `#removeEntry`'s two deletions are attempted as a pair and a genuine failure is surfaced, not silently
 *   dropped along with whichever half succeeded.
 * - **B1**: `index.json` is now written through `writeFileAtomic` like every other store in this app, and a
 *   corrupt (not merely absent) index is rebuilt from the files actually on disk rather than silently treated as
 *   empty -- see `#readIndex`/`#rebuildIndexFromDisk`.
 * - **B2/B3**: `#doGet`'s two cleanup branches each remove the index entry and the files in one step, so neither
 *   can leave the other behind.
 */
export class VendorCache {
  /** Fix round 1 (I1): the single process-wide queue every `index.json` read-modify-write runs through. */
  #indexQueue: Promise<void> = Promise.resolve();
  /** Fix round 1 (C1): one promise chain per key currently in flight; see `#exclusive`. */
  #keyLocks = new Map<string, Promise<void>>();
  /** Fix round 2 (I2): eviction's background per-key deletions currently in flight; see `#evict`, `waitIdle`. */
  #pendingEvictions = new Set<Promise<void>>();
  /**
   * Fix round 3 (A1): bumped by every `invalidateAll()` call, synchronously, before that call awaits anything.
   * `#doSet` (and `#doGet`'s two cleanup branches) capture this on entry and re-check it immediately before
   * publishing/persisting -- if it moved, a wipe was decided during this call, so the call discards whatever it
   * did rather than leaving a phantom. There is no instant at which "no future `set()` exists" for a wider drain
   * to wait for, which is why this is a generation counter and not a bigger `#keyLocks` snapshot.
   */
  #generation = 0;
  /**
   * Fix round 3 (A1): set for the duration of `invalidateAll()`'s physical `rm()`, so `#doSet` can wait one out
   * before starting its own writes -- necessary *in addition to* `#generation`, not instead of it. The counter
   * alone only catches a wipe that starts *during* a write already in progress; it can't catch a write that starts
   * *after* the bump but while the (multi-file, non-atomic) `rm()` is still physically running, since that write
   * captures the already-bumped generation and never sees it change again. Measured directly: without this gate,
   * a `set()` for a brand-new key fired on a macrotask after `invalidateAll()` was called still landed a phantom
   * in 14-24 of 40 trials even with the generation check in place.
   */
  #activeWipe: Promise<void> | null = null;

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
   * through, so it can't interleave with a concurrent index read/write either.
   *
   * Fix round 3 (A1): the drain above only protects calls *already registered* when the snapshot is taken -- it
   * was previously (and incorrectly) described as making a not-yet-registered `set()` a "clean outcome, not a
   * race" too. It isn't: there is no instant at which no further `set()` can start, so a `set()` that begins around
   * this wipe could still publish into (or just after) a directory this call just cleared. Two things close that,
   * together: the generation bump, synchronous and first, so any `set()`/`get()` cleanup that checks it afterward
   * -- whenever it happens to run -- sees the new generation and discards its own work instead of publishing a
   * phantom; and `#activeWipe`, published just as synchronously, so a `set()` that starts *after* the bump (and so
   * never sees the generation change) still waits for this call's `rm()` to fully finish before it writes anything,
   * rather than possibly racing it. A `set()` that captured its generation *before* this bump either finishes
   * before the wipe starts (and is then wiped along with everything else -- clean) or is still mid-write when the
   * wipe's `rm()` runs and has its files removed by that same `rm()` -- also clean, just not a phantom either way.
   */
  async invalidateAll(): Promise<void> {
    await Promise.all([...this.#keyLocks.values()]);
    this.#generation++;
    const wipe = this.#withIndex(
      async () => {
        await rm(this.deps.cacheDir, { recursive: true, force: true });
      },
      { persist: false },
    );
    const settledWipe: Promise<void> = wipe.then(
      () => undefined,
      () => undefined,
    );
    this.#activeWipe = settledWipe;
    try {
      await wipe;
    } finally {
      if (this.#activeWipe === settledWipe) this.#activeWipe = null;
    }
  }

  async #doGet(key: string): Promise<VendorChunk | null> {
    const generation = this.#generation;
    const entry = await this.#withIndex((index) => index[key], { persist: false });
    if (!entry) return null;
    if (this.#now() - entry.writtenAt > this.#maxAgeMs()) {
      // Fix round 3 (B3): mirrors `#deleteIfStillAbsent`'s ordering, not just its "one #withIndex call" shape --
      // the index removal is *persisted first*, and the physical delete happens only afterward, once it's durable.
      // Doing it the other way around (delete files, then persist the index change, as this used to) leaves a
      // window in which `index.json` on disk still claims an entry whose files are already gone -- observed in 27
      // of 79 read-only samples at HEAD -- which is exactly the dangerous direction (an index entry pointing at
      // nothing). This ordering's own transient window points the other way (files still on disk with no index
      // entry for an instant), which is the direction every other path in this file already treats as benign by
      // design (`#evict`'s own eviction order does the same). Fix round 3 (A1): skipped if a wipe was decided
      // since this call started -- that wipe already removes this entry and these files.
      const stillStale = await this.#withIndex((index) => {
        if (this.#generation !== generation || !(key in index)) return false;
        delete index[key];
        return true;
      });
      if (stillStale) await this.#removeEntry(key);
      return null;
    }
    try {
      const [code, map] = await Promise.all([
        readFile(this.#codePath(key), "utf8"),
        readFile(this.#mapPath(key), "utf8"),
      ]);
      return { code, map };
    } catch {
      // Fix round 3 (B2): the index and the files on disk disagree (e.g. a hand-cleared cache dir, or one half of
      // the pair lost to a genuine I/O error) -- treat it as a miss and repair *both* the index and the surviving
      // sibling file, not just the index. Leaving the sibling behind would leak it permanently: once a key is gone
      // from the index, `#evict`'s sweep (which only walks `Object.entries(index)`) can never reconsider it.
      // Same ordering as the stale branch above (index persisted first, then the physical delete) and the same
      // fix round 3 (A1) generation guard, for the same reasons.
      const stillMismatched = await this.#withIndex((index) => {
        if (this.#generation !== generation || !(key in index)) return false;
        delete index[key];
        return true;
      });
      if (stillMismatched) await this.#removeEntry(key);
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
   *
   * Fix round 3 (A1): waits out any `invalidateAll()` currently in progress *before* doing anything else -- a
   * write that started after the bump would never see `#generation` change on its own, so without this a wipe's
   * `rm()` could still be physically running while this call's `writeFileAtomic`s land in the same directory.
   * `generation` is captured only after that wait, so it reflects whichever wipe (if any) this call is *not*
   * racing. The check just before publishing the index entry is the one place this call commits to being visible
   * at all -- if `invalidateAll()` bumped the generation since this call started, that publish is skipped and
   * whatever this call wrote is discarded instead (`#removeEntry`), so a `set()` that loses the race to a *later*
   * wipe leaves nothing behind, not a phantom index entry.
   */
  async #doSet(key: string, chunk: VendorChunk): Promise<void> {
    while (this.#activeWipe) await this.#activeWipe;
    const generation = this.#generation;
    await Promise.all([
      writeFileAtomic(this.#codePath(key), chunk.code),
      writeFileAtomic(this.#mapPath(key), chunk.map),
    ]);
    const size = Buffer.byteLength(chunk.code, "utf8") + Buffer.byteLength(chunk.map, "utf8");
    const writtenAt = this.#now();
    const published = await this.#withIndex((index) => {
      if (this.#generation !== generation) return false;
      index[key] = { size, writtenAt };
      return true;
    });
    if (!published) {
      await this.#removeEntry(key);
      return;
    }
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

  /**
   * Fix round 3 (B1): distinguishes "absent" (`ENOENT`: legitimately empty cache -- `{}`, no scan) from "corrupt"
   * (missing but for another reason, unreadable, not valid JSON, or valid JSON that isn't an object -- e.g. a
   * `index.json` truncated by a kill signal or power loss mid-`writeFile`, which is exactly the shape a plain,
   * non-atomic write leaves behind). Silently treating corruption as an empty index -- the previous behaviour --
   * meant the very next `set()` persisted that emptiness over the top, permanently orphaning every file already on
   * disk (invisible to `#evict`, which only ever walks `Object.entries(index)`) and silently disabling the size
   * cap against them. Corruption instead rebuilds the index from the files actually on disk (chosen over
   * quarantine-and-start-clean specifically because that alternative is what orphans everything this fix exists to
   * stop orphaning) and persists the rebuild immediately, so the repair is durable on the very next read, not just
   * for this one lookup.
   */
  async #readIndex(): Promise<VendorCacheIndex> {
    let raw: string;
    try {
      raw = await readFile(this.#indexPath(), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return {};
      return this.#rebuildIndexFromDisk();
    }
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed as VendorCacheIndex;
    } catch {
      // fall through to the rebuild below
    }
    return this.#rebuildIndexFromDisk();
  }

  /**
   * Fix round 3 (B1): the on-disk `.js`/`.js.map` pairs are the source of truth once `index.json` itself can't be
   * trusted. Only a *complete* pair is reconstructed -- a lone `.js` or `.js.map` (itself only reachable through a
   * genuine I/O error under A2, since B2/B3 no longer leave one after an ordinary repair) is left alone rather
   * than guessed at, since there's no `size`/`writtenAt` to recover for it and no chunk to serve either half of.
   * `size` and `writtenAt` are reconstructed from `stat`, not remembered, so a rebuilt entry's age is exact (its
   * files' own mtimes) rather than defaulted to "now" (which would let a genuinely stale entry survive an extra
   * `VENDOR_CACHE_MAX_AGE_MS` past truncation).
   */
  async #rebuildIndexFromDisk(): Promise<VendorCacheIndex> {
    let files: string[];
    try {
      files = await readdir(this.deps.cacheDir);
    } catch {
      return {};
    }
    const names = new Set(files);
    const index: VendorCacheIndex = {};
    for (const file of files) {
      if (!file.endsWith(".js") || file.endsWith(".js.map")) continue;
      const key = file.slice(0, -".js".length);
      if (!names.has(`${key}.js.map`)) continue;
      try {
        const [codeInfo, mapInfo] = await Promise.all([
          stat(join(this.deps.cacheDir, file)),
          stat(join(this.deps.cacheDir, `${key}.js.map`)),
        ]);
        index[key] = { size: codeInfo.size + mapInfo.size, writtenAt: Math.min(codeInfo.mtimeMs, mapInfo.mtimeMs) };
      } catch {
        // Raced with something deleting this exact pair between readdir and stat; leave it out rather than guess.
      }
    }
    await this.#writeIndex(index);
    return index;
  }

  async #writeIndex(index: VendorCacheIndex): Promise<void> {
    // Fix round 3 (B1): `writeFileAtomic`, not a plain `writeFile` -- `index.json` was the one store in this app
    // still written by truncate-in-place, which is exactly what a kill signal or power loss can catch mid-write.
    await writeFileAtomic(this.#indexPath(), JSON.stringify(index));
  }

  /**
   * Fix round 3 (A2): both deletions are always attempted -- `Promise.allSettled`, not `Promise.all`, so a
   * `force:true` "file already gone" outcome on one path never short-circuits the other -- and a genuine failure
   * (a real I/O error; `force:true` already makes a missing file harmless) is surfaced to the caller rather than
   * silently dropped, so it can't masquerade as a clean deletion when only one half of the pair actually went.
   */
  async #removeEntry(key: string): Promise<void> {
    const results = await Promise.allSettled([
      rm(this.#codePath(key), { force: true }),
      rm(this.#mapPath(key), { force: true }),
    ]);
    const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failed) throw failed.reason;
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
        // Fix round 3 (A2 comment correction): a failure here (a genuine `#removeEntry` I/O error, or losing this
        // key's lock race -- see #deleteIfStillAbsent) is best-effort only. The claim this comment used to make --
        // "the next eviction pass... naturally retries reclaiming it" -- doesn't hold: once a key is removed from
        // `index.json` (already done, durably, by the decision step above), `#evict`'s own sweep can never
        // reconsider it again, since it only ever walks `Object.entries(index)`. A failure here can therefore
        // leave a permanently orphaned, index-less file pair on disk rather than a merely delayed cleanup -- rare
        // (it requires a real I/O error, not just a missing file), silent, and not corrupting (never a corrupt
        // read), but permanent, not retried.
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
