import { describe, expect, test } from "bun:test";
import { createOsPolyfill, createProcessPolyfill } from "../src/polyfills";
import { createCryptoPolyfill } from "../src/polyfills/crypto";
import type { OsSnapshot } from "../src/polyfills/os";
import type { ProcessSnapshot } from "../src/polyfills/process";

describe("createProcessPolyfill (spec §5.13)", () => {
  const snapshot: ProcessSnapshot = {
    env: { PATH: "/usr/bin", FOO: "bar" },
    cwd: "/Users/example/project",
    platform: "darwin",
    argv: ["bun", "entry.js"],
    versions: { node: "22.20.2", bun: "1.3.13" },
  };

  test("env, cwd, platform, argv and versions come straight from the snapshot", () => {
    const process = createProcessPolyfill(snapshot);
    expect(process.env).toEqual({ PATH: "/usr/bin", FOO: "bar" });
    expect(process.cwd()).toBe("/Users/example/project");
    expect(process.platform).toBe("darwin");
    expect(process.argv).toEqual(["bun", "entry.js"]);
    expect(process.versions).toEqual({ node: "22.20.2", bun: "1.3.13" });
    expect(process.version).toBe("v22.20.2");
  });

  test("env is copied, not aliased -- mutating the polyfill's env never touches the snapshot", () => {
    const process = createProcessPolyfill(snapshot);
    process.env.FOO = "mutated";
    expect(snapshot.env.FOO).toBe("bar");
  });

  test("two polyfills built from the same snapshot never share env identity", () => {
    const a = createProcessPolyfill(snapshot);
    const b = createProcessPolyfill(snapshot);
    a.env.FOO = "a-only";
    expect(b.env.FOO).toBe("bar");
  });

  /**
   * Fix round 1 (M4): the previous version of this test waited on a macrotask (`setTimeout(resolve, 0)`) to
   * observe `nextTick`, and a macrotask-based `nextTick` (`setTimeout(cb, 0)` instead of `queueMicrotask`) would
   * have fired before that same-delay `setTimeout` too (equal-delay timers run in scheduling order) -- so the
   * test passed either way, proven by mutation. This version instead awaits a single microtask hop
   * (`Promise.resolve()`), which a macrotask callback cannot have run by: `nextTick`'s callback and the `.then()`
   * callback are both queued (in that order) *before* the `await`'s own continuation microtask, so one hop is
   * enough to observe both, and it is exactly the same technique the neighbouring "forwards extra arguments"
   * test below already uses successfully (per the fix-round-1 review, that one already discriminates).
   */
  test("nextTick runs on the microtask queue, strictly before a macrotask", async () => {
    const process = createProcessPolyfill(snapshot);
    const order: string[] = [];
    process.nextTick(() => order.push("nextTick"));
    Promise.resolve().then(() => order.push("promise-then"));
    order.push("sync");
    await Promise.resolve();
    expect(order).toEqual(["sync", "nextTick", "promise-then"]);
  });

  test("nextTick forwards extra arguments to the callback, like Node's", async () => {
    const process = createProcessPolyfill(snapshot);
    const seen: unknown[] = [];
    process.nextTick((...args: unknown[]) => seen.push(...args), 1, "two");
    await Promise.resolve();
    expect(seen).toEqual([1, "two"]);
  });

  test("versions falls back to v0.0.0 when the snapshot carries no node version", () => {
    const process = createProcessPolyfill({ ...snapshot, versions: {} });
    expect(process.version).toBe("v0.0.0");
  });

  test("browser is true (the long-standing browserify/webpack convention npm packages branch on)", () => {
    expect(createProcessPolyfill(snapshot).browser).toBe(true);
  });
});

describe("createOsPolyfill (spec §5.13, snapshot values, sync)", () => {
  const snapshot: OsSnapshot = {
    arch: "arm64",
    platform: "darwin",
    release: "24.0.0",
    type: "Darwin",
    version: "Darwin Kernel Version 24.0.0",
    homedir: "/Users/example",
    tmpdir: "/tmp",
    hostname: "examples-mac",
    endianness: "LE",
    eol: "\n",
    cpus: [
      { model: "Apple M2", speed: 3500 },
      { model: "Apple M2", speed: 3500 },
    ],
    totalmem: 17179869184,
    freemem: 4294967296,
  };

  test("every accessor returns the matching snapshot value", () => {
    const os = createOsPolyfill(snapshot);
    expect(os.arch()).toBe("arm64");
    expect(os.platform()).toBe("darwin");
    expect(os.release()).toBe("24.0.0");
    expect(os.type()).toBe("Darwin");
    expect(os.version()).toBe("Darwin Kernel Version 24.0.0");
    expect(os.homedir()).toBe("/Users/example");
    expect(os.tmpdir()).toBe("/tmp");
    expect(os.hostname()).toBe("examples-mac");
    expect(os.endianness()).toBe("LE");
    expect(os.EOL).toBe("\n");
    expect(os.cpus()).toEqual(snapshot.cpus);
    expect(os.totalmem()).toBe(17179869184);
    expect(os.freemem()).toBe(4294967296);
  });

  test("cpus() returns a fresh copy each call, never the snapshot's own array/objects", () => {
    const os = createOsPolyfill(snapshot);
    const first = os.cpus();
    // biome-ignore lint/style/noNonNullAssertion: fixture always has two entries; asserting the mutation path.
    first[0]!.model = "mutated";
    // biome-ignore lint/style/noNonNullAssertion: same fixture.
    expect(os.cpus()[0]!.model).toBe("Apple M2");
    // biome-ignore lint/style/noNonNullAssertion: same fixture.
    expect(snapshot.cpus[0]!.model).toBe("Apple M2");
  });
});

describe("createCryptoPolyfill (spec §5.13)", () => {
  test("randomUUID returns a real v4 UUID from the native webcrypto", () => {
    const crypto = createCryptoPolyfill();
    const uuid = crypto.randomUUID();
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  test("getRandomValues fills the given typed array in place and returns it", () => {
    const crypto = createCryptoPolyfill();
    const bytes = new Uint8Array(16);
    const returned = crypto.getRandomValues(bytes);
    expect(returned).toBe(bytes);
    expect(bytes.some((byte) => byte !== 0)).toBe(true);
  });

  test("webcrypto is the real global Crypto object, not a stand-in", () => {
    const crypto = createCryptoPolyfill();
    expect(crypto.webcrypto).toBe(globalThis.crypto);
  });

  test("webcrypto can be overridden (dependency injection for a fake page global)", () => {
    const fake = { randomUUID: () => "fake-uuid" } as unknown as Crypto;
    const crypto = createCryptoPolyfill(fake);
    expect(crypto.webcrypto).toBe(fake);
    expect(crypto.randomUUID()).toBe("fake-uuid");
  });

  test("createHash produces a correct, real digest (sha256('abc'))", () => {
    const crypto = createCryptoPolyfill();
    const digest = crypto.createHash("sha256").update("abc").digest("hex");
    expect(digest).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  test("createHash produces a correct, real digest (md5('abc'))", () => {
    const crypto = createCryptoPolyfill();
    const digest = crypto.createHash("md5").update("abc").digest("hex");
    expect(digest).toBe("900150983cd24fb0d6963f7d28e17f72");
  });

  test("createHmac produces a correct, real HMAC (sha256, key 'key', message 'abc')", () => {
    const crypto = createCryptoPolyfill();
    const digest = crypto.createHmac("sha256", "key").update("abc").digest("hex");
    expect(digest).toBe("9c196e32dc0175f86f4b1cb89289d6619de6bee699e4c378e68309ed97a1a6ab");
  });
});
