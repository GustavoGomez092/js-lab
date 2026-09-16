import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hashBunLock,
  VENDOR_CACHE_MAX_AGE_MS,
  VENDOR_CACHE_MAX_TOTAL_BYTES,
  VendorCache,
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
