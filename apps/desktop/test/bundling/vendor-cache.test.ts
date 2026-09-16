import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hashBunLock,
  VENDOR_CACHE_MAX_AGE_MS,
  VENDOR_CACHE_MAX_TOTAL_BYTES,
  VendorCache,
  type VendorChunk,
  vendorCacheKey,
} from "../../src/main/bundling/vendor-cache";

let cacheDir = "";

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "jslab-vendor-cache-"));
});

afterEach(async () => {
  await rm(cacheDir, { recursive: true, force: true });
});

describe("vendorCacheKey", () => {
  test("is stable regardless of import order", () => {
    const lockHash = hashBunLock('{"lockfileVersion":2}');
    const a = vendorCacheKey(lockHash, ["react-dom", "react"]);
    const b = vendorCacheKey(lockHash, ["react", "react-dom"]);
    expect(a).toBe(b);
  });

  test("changes when the lock hash or the import set changes, holding the other fixed", () => {
    const lockHashA = hashBunLock('{"lockfileVersion":2,"a":1}');
    const lockHashB = hashBunLock('{"lockfileVersion":2,"a":2}');
    const baseline = vendorCacheKey(lockHashA, ["react"]);

    expect(vendorCacheKey(lockHashB, ["react"])).not.toBe(baseline);
    expect(vendorCacheKey(lockHashA, ["react", "react-dom"])).not.toBe(baseline);
  });
});

describe("VendorCache", () => {
  test("set then get round-trips the code and source map for a key", async () => {
    const cache = new VendorCache({ cacheDir });
    const key = vendorCacheKey(hashBunLock("{}"), ["react"]);

    expect(await cache.get(key)).toBeNull();
    await cache.set(key, { code: "console.log('react vendor chunk')", map: '{"version":3}' });

    const hit = await cache.get(key);
    expect(hit).toEqual({ code: "console.log('react vendor chunk')", map: '{"version":3}' });
  });

  test("get treats an entry older than VENDOR_CACHE_MAX_AGE_MS as a miss and removes it from disk", async () => {
    let now = 1_000_000;
    const cache = new VendorCache({ cacheDir, now: () => now });
    const key = vendorCacheKey(hashBunLock("{}"), ["react"]);
    await cache.set(key, { code: "code", map: "map" });
    expect(await cache.get(key)).toEqual({ code: "code", map: "map" }); // still fresh, before advancing the clock

    now += VENDOR_CACHE_MAX_AGE_MS + 1;
    expect(await cache.get(key)).toBeNull();

    // A fresh cache instance (no in-memory state) must see the same eviction, proving it happened on disk.
    const reopened = new VendorCache({ cacheDir, now: () => now });
    expect(await reopened.get(key)).toBeNull();
  });

  test("set evicts the oldest entries once the total size passes VENDOR_CACHE_MAX_TOTAL_BYTES", async () => {
    let now = 0;
    const cache = new VendorCache({ cacheDir, now: () => now, maxTotalBytes: 20 });
    const oldKey = vendorCacheKey(hashBunLock("{}"), ["old-pkg"]);
    const newKey = vendorCacheKey(hashBunLock("{}"), ["new-pkg"]);

    await cache.set(oldKey, { code: "0123456789", map: "" }); // 10 bytes, under the 20-byte cap alone
    now += 1;
    await cache.set(newKey, { code: "0123456789", map: "0123456789" }); // pushes the total to 30 bytes

    expect(await cache.get(oldKey)).toBeNull(); // evicted: it was written first
    expect(await cache.get(newKey)).toEqual({ code: "0123456789", map: "0123456789" });
  });

  test("invalidateAll clears every cached entry, joining the npm-change invalidation path", async () => {
    const cache = new VendorCache({ cacheDir });
    const keyA = vendorCacheKey(hashBunLock("{}"), ["react"]);
    const keyB = vendorCacheKey(hashBunLock("{}"), ["lodash"]);
    await cache.set(keyA, { code: "a", map: "a-map" });
    await cache.set(keyB, { code: "b", map: "b-map" });
    expect(await cache.get(keyA)).toEqual({ code: "a", map: "a-map" }); // both present before invalidation
    expect(await cache.get(keyB)).toEqual({ code: "b", map: "b-map" });

    await cache.invalidateAll();

    expect(await cache.get(keyA)).toBeNull();
    expect(await cache.get(keyB)).toBeNull();
  });
});

describe("VendorCache concurrency (fix round 1)", () => {
  /**
   * C1: reproduces the reviewer's torn-write / mismatched-pair race entirely through the public `get()`/`set()`
   * API (never touching the filesystem directly), so this test exercises exactly what a real caller (Task 7,
   * bundling several tabs at once) would do. Mirrors the reviewer's own methodology (`task-6-review.md`): one
   * continuous writer alternates two full-size, easily distinguishable payloads (~200 KB code / ~20 KB map each,
   * built from a single repeated character so any byte mixing -- a torn write -- shows up immediately as a
   * non-uniform string) into the *same* key, while several readers hammer `get()` for that same key throughout the
   * whole write sequence. Every successful `get()` is checked for two things a corrupt cache could violate: the
   * code is either wholly payload A or wholly payload B (never torn/mixed), and its map is the map that belongs to
   * *that same* payload (never a mismatched pair).
   *
   * An earlier version of this test fired all the `set()`/`get()` calls at once via `Promise.all` over two flat
   * arrays and never reproduced anything against the pre-fix code -- a `get()` against an empty/nonexistent cache
   * fails fast (no file to read), so every read against the still-warming-up cache "won" the race and returned a
   * clean miss before any write finished. Priming the cache first, then running one continuous writer loop
   * alongside concurrent reader loops for the writer's whole duration, matches the reviewer's fixture and reliably
   * exercises the actual race window (a write in progress, not an empty cache).
   *
   * Loop count: 100 sequential `set()` calls (alternating A/B) from one writer, read throughout by 8 concurrent
   * readers. Chosen empirically (see the fix-round-1 report): 5 exploratory runs at this size against the pre-fix
   * code produced 55-62 mismatched pairs out of ~1,300 reads every time (never zero), in ~40 ms; smaller loop
   * counts (down to 50) still reproduced it reliably too, so 100 leaves comfortable margin above the noise floor
   * without slowing the suite. Against the fixed code this same test completes in well under a second with zero
   * violations, every time -- the fix makes the pairing invariant hold by construction (same-key `get()`/`set()`
   * calls are fully serialized), not just statistically less likely, so there is no flake risk on the green side.
   */
  test("concurrent set() calls for the same key never let get() observe a torn chunk or a mismatched code/map pair", async () => {
    const cache = new VendorCache({ cacheDir });
    const key = vendorCacheKey(hashBunLock("{}"), ["react", "react-dom"]);
    const payloads = {
      A: { code: "A".repeat(200_000), map: "a".repeat(20_000) },
      B: { code: "B".repeat(200_000), map: "b".repeat(20_000) },
    } as const;
    const ITERATIONS = 100;
    const READER_CONCURRENCY = 8;

    await cache.set(key, payloads.A); // prime the cache so readers have something to race against from the start

    let writing = true;
    const reads: (VendorChunk | null)[] = [];

    async function writer() {
      for (let i = 0; i < ITERATIONS; i++) {
        await cache.set(key, i % 2 === 0 ? payloads.A : payloads.B);
      }
      writing = false;
    }

    async function reader() {
      while (writing) {
        reads.push(await cache.get(key));
      }
    }

    await Promise.all([writer(), ...Array.from({ length: READER_CONCURRENCY }, () => reader())]);

    const violations: string[] = [];
    for (const hit of reads) {
      if (!hit) continue; // a clean miss is always safe
      const isPureA = hit.code === payloads.A.code;
      const isPureB = hit.code === payloads.B.code;
      if (!isPureA && !isPureB) {
        violations.push(`torn code: length ${hit.code.length}, not uniformly A or B`);
        continue;
      }
      const expectedMap = isPureA ? payloads.A.map : payloads.B.map;
      if (hit.map !== expectedMap) {
        violations.push(`mismatched pair: code matches ${isPureA ? "A" : "B"} but map does not match its own`);
      }
    }
    expect(reads.length).toBeGreaterThan(0); // sanity: readers actually ran concurrently with the writer
    expect(violations).toEqual([]);
  });

  /**
   * I1: many concurrent `set()` calls for *distinct* keys on one shared `VendorCache` instance -- the ordinary
   * multi-tab shape the reviewer measured losing 24 of 25 entries against the pre-fix code, because the shared
   * `index.json` read-modify-write had no serialization.
   *
   * Loop count: 40 distinct keys. Chosen empirically (see the fix-round-1 report) as comfortably larger than the
   * reviewer's own 25-key reproduction (so it's at least as likely to expose the race), while still completing
   * near-instantly against the fixed code -- each `set()` writes only a few bytes, so the cost here is entirely
   * the number of concurrent index read-modify-write cycles, not I/O volume.
   */
  test("concurrent set() calls for distinct keys never lose an index entry", async () => {
    const cache = new VendorCache({ cacheDir });
    const KEY_COUNT = 40;
    const keys = Array.from({ length: KEY_COUNT }, (_, i) => vendorCacheKey(hashBunLock("{}"), [`pkg-${i}`]));

    await Promise.all(keys.map((key, i) => cache.set(key, { code: `code-${i}`, map: `map-${i}` })));

    const results = await Promise.all(keys.map((key) => cache.get(key)));
    const lost = results.filter((hit) => hit === null).length;
    expect(lost).toBe(0);
    results.forEach((hit, i) => {
      expect(hit).toEqual({ code: `code-${i}`, map: `map-${i}` });
    });
  });
});

describe("VendorCache concurrency (fix round 2)", () => {
  /** Reads index.json and the cache directory directly, bypassing VendorCache, matching the re-review's own method
   *  ("direct filesystem check against index.json afterward -- no get() called, so no self-heal could have run"). */
  async function readIndexAndFilesDirect(dir: string): Promise<{
    index: Record<string, { size: number; writtenAt: number }>;
    codeFiles: Set<string>;
    mapFiles: Set<string>;
  }> {
    let index: Record<string, { size: number; writtenAt: number }> = {};
    try {
      index = JSON.parse(await readFile(join(dir, "index.json"), "utf8"));
    } catch {
      index = {};
    }
    let files: string[] = [];
    try {
      files = await readdir(dir);
    } catch {
      files = [];
    }
    const codeFiles = new Set(files.filter((f) => f.endsWith(".js")).map((f) => f.slice(0, -3)));
    const mapFiles = new Set(files.filter((f) => f.endsWith(".js.map")).map((f) => f.slice(0, -".js.map".length)));
    return { index, codeFiles, mapFiles };
  }

  /** Every index entry's files must exist, and every on-disk file must have an index entry -- the invariant fix2
   *  requires after eviction. Returns a list of English violation descriptions (empty means the invariant holds). */
  function invariantViolations(state: Awaited<ReturnType<typeof readIndexAndFilesDirect>>): string[] {
    const violations: string[] = [];
    for (const key of Object.keys(state.index)) {
      if (!state.codeFiles.has(key)) violations.push(`index claims ${key} but its .js file is missing`);
      if (!state.mapFiles.has(key)) violations.push(`index claims ${key} but its .js.map file is missing`);
    }
    for (const key of state.codeFiles) {
      if (!(key in state.index)) violations.push(`.js file for ${key} has no index entry`);
    }
    for (const key of state.mapFiles) {
      if (!(key in state.index)) violations.push(`.js.map file for ${key} has no index entry`);
    }
    return violations;
  }

  /**
   * I2: reproduces the re-review's scenario -- a concurrent same-key `set()` racing eviction's physical deletion of
   * that same key's *older* generation -- and asserts the invariant directly on the filesystem: every index entry's
   * files exist, and every file on disk has an index entry.
   *
   * `H`'s stale generation is established *sequentially* first (with a fake `now()` far in the past, so it reads as
   * old the instant the race begins), so the race itself only ever writes `H` once. Ten other keys, each written
   * exactly once, then race concurrently against that single `H` rewrite under a tight `maxTotalBytes`, so several
   * of their eviction decisions get a chance to target `H`'s now-stale entry while `H`'s own (single) rewrite is
   * concurrently in flight -- exactly the NEW-1 window (a decision made against a snapshot that a concurrent
   * same-key `set()` then invalidates before the physical delete runs).
   *
   * Trial count: 60. `H`'s single-write-during-the-race structure was deliberately chosen (over, say, rewriting
   * several keys many times each) after an earlier draft of this test -- which did exactly that -- turned out to
   * also intermittently trip a *separate*, pre-existing defect in the core `#exclusive`/`#withIndex` machinery
   * itself (present already in `f8cbdaa`, C1/I1's own commit; reproducible with as few as two keys each `set()`
   * twice concurrently, with `maxTotalBytes` left at its default so eviction never runs at all -- see the
   * fix-round-2 report, filed as a new, out-of-scope finding). Since only `H` is ever written more than once here,
   * and only once during the race itself, this test does not exercise that separate defect's trigger condition.
   * Measured over many repeated `bun test` runs at this trial count: the pre-fix rate is consistently 15-32%
   * (9-19/60 trials violate), never zero; the post-fix rate is consistently exactly 0/60, every run. The assertion
   * below is therefore a genuine zero-tolerance one, matching this file's other concurrency tests.
   */
  test("a concurrent same-key set() racing eviction never leaves the index and the files on disk disagreeing", async () => {
    const TRIALS = 60;
    const OTHER_KEYS = 10;
    const MAX_TOTAL_BYTES = 30;
    let violatedTrials = 0;

    for (let trial = 0; trial < TRIALS; trial++) {
      const dir = await mkdtemp(join(tmpdir(), "jslab-vendor-cache-i2-"));
      try {
        let clock = 0;
        const cache = new VendorCache({ cacheDir: dir, maxTotalBytes: MAX_TOTAL_BYTES, now: () => clock });
        const hotKey = vendorCacheKey(hashBunLock("{}"), ["hot"]);

        await cache.set(hotKey, { code: "gen0-code", map: "gen0-map" }); // stale generation, established first
        clock = 1_000_000; // already looks old the instant the race below starts

        const otherKeys = Array.from({ length: OTHER_KEYS }, (_, i) =>
          vendorCacheKey(hashBunLock("{}"), [`other-${i}`]),
        );
        await Promise.all([
          cache.set(hotKey, { code: "gen1-code", map: "gen1-map" }), // hotKey's only write during the race
          ...otherKeys.map((key, i) => cache.set(key, { code: `o-${i}`, map: `om-${i}` })), // each written once
        ]);
        await cache.waitIdle();

        const violations = invariantViolations(await readIndexAndFilesDirect(dir));
        if (violations.length > 0) violatedTrials++;
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }

    expect(violatedTrials).toBe(0);
  });

  /**
   * M2: `invalidateAll()` must not surface real promise rejections into `set()`/`get()` calls that were already in
   * flight when it was called (which is exactly what happened before this fix -- the wipe could land mid-write).
   * Every `set()`/`get()` below is fired synchronously (not individually awaited) before `invalidateAll()` is
   * called in the same tick, so `#exclusive` has already registered each of them in `#keyLocks` by the time
   * `invalidateAll()` takes its drain snapshot -- guaranteeing they're all covered by the wait, deterministically,
   * not by luck of timing.
   */
  test("invalidateAll() concurrent with in-flight set()/get() calls completes without rejections and leaves the cache empty", async () => {
    const cache = new VendorCache({ cacheDir });
    const keys = Array.from({ length: 5 }, (_, i) => vendorCacheKey(hashBunLock("{}"), [`pkg-${i}`]));

    const inFlight: Promise<unknown>[] = keys.map((key, i) => cache.set(key, { code: `code-${i}`, map: `map-${i}` }));
    inFlight.push(...keys.map((key) => cache.get(key)));
    const invalidatePromise = cache.invalidateAll();

    const results = await Promise.allSettled([invalidatePromise, ...inFlight]);
    const rejections = results.filter((result) => result.status === "rejected");
    expect(rejections).toEqual([]);

    for (const key of keys) {
      expect(await cache.get(key)).toBeNull();
    }
  });
});
