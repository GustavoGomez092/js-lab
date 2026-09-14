import { describe, expect, test } from "bun:test";
import { types } from "node:util";
import type { EncodedValue } from "@jslab/rpc-schema";
import fc from "fast-check";
import {
  clipToJsonBytes,
  DEFAULT_LIMITS,
  Encoder,
  HandleRegistry,
  jsonStringBytes,
  MAX_EXPAND_BYTES,
  parseStack,
} from "../src/encode";

const make = (limits = DEFAULT_LIMITS) => {
  const registry = new HandleRegistry();
  return new Encoder(registry, limits, {
    peekPromise: (p) => {
      const state = Bun.peek.status(p);
      return state === "pending" ? { state } : { state, value: Bun.peek(p) };
    },
    isProxy: (v) => types.isProxy(v),
  });
};

describe("primitives", () => {
  test("encodes numbers losslessly", () => {
    const e = make();
    expect(e.encode(-0)).toEqual({ t: "number", v: "-0" });
    expect(e.encode(Number.NaN)).toEqual({ t: "number", v: "NaN" });
    expect(e.encode(Number.POSITIVE_INFINITY)).toEqual({ t: "number", v: "Infinity" });
    expect(e.encode(1.5)).toEqual({ t: "number", v: "1.5" });
  });

  test("encodes other primitives", () => {
    const e = make();
    expect(e.encode(undefined)).toEqual({ t: "undefined" });
    expect(e.encode(null)).toEqual({ t: "null" });
    expect(e.encode(true)).toEqual({ t: "boolean", v: true });
    expect(e.encode(10n ** 30n)).toEqual({ t: "bigint", v: "1000000000000000000000000000000" });
    expect(e.encode(Symbol("s"))).toEqual({ t: "symbol", desc: "s" });
  });

  test("truncates long strings behind a handle that expands to the full text", () => {
    const e = make({ ...DEFAULT_LIMITS, maxString: 4 });
    const encoded = e.encode("abcdefgh");
    expect(encoded).toMatchObject({ t: "string", v: "abcd", truncated: { total: 8 } });
    const handle = (encoded as { truncated: { handle: string } }).truncated.handle;
    expect(e.expand(handle)).toEqual({ t: "string", v: "abcdefgh" });
  });
});

describe("objects", () => {
  test("encodes plain objects with constructor names", () => {
    class Point {
      constructor(
        public x = 1,
        public y = 2,
      ) {}
    }
    const encoded = make().encode(new Point());
    expect(encoded).toMatchObject({
      t: "object",
      ctor: "Point",
      props: [
        [{ k: "x" }, { t: "number", v: "1" }],
        [{ k: "y" }, { t: "number", v: "2" }],
      ],
    });
    expect(make().encode(Object.create(null))).toMatchObject({ t: "object", ctor: null, props: [] });
  });

  test("turns values beyond max depth into expandable handles", () => {
    const e = make({ ...DEFAULT_LIMITS, maxDepth: 1 });
    const encoded = e.encode({ inner: { deep: 1 } });
    const inner = (encoded as { props: [unknown, { t: string; handle: string; preview: string }][] }).props[0]?.[1];
    expect(inner).toMatchObject({ t: "handle", preview: "Object {…}" });
    expect(e.expand(inner?.handle ?? "")).toMatchObject({
      t: "object",
      props: [[{ k: "deep" }, { t: "number", v: "1" }]],
    });
  });

  test("marks true cycles as circular but not shared references", () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    expect(JSON.stringify(make().encode(a))).toContain('"t":"circular"');
    const shared = { n: 1 };
    expect(JSON.stringify(make().encode({ one: shared, two: shared }))).not.toContain("circular");
  });

  test("evaluates getters only on expand, against the instance", () => {
    let calls = 0;
    class Temp {
      c = 20;
      get f() {
        calls++;
        return this.c * 2;
      }
    }
    const e = make();
    const encoded = e.encode(new Temp()) as { props: [{ k: string }, { t: string; handle: string }][] };
    const getter = encoded.props.find(([k]) => k.k === "f")?.[1];
    expect(getter?.t).toBe("getter");
    expect(calls).toBe(0);
    expect(e.expand(getter?.handle ?? "")).toEqual({ t: "number", v: "40" });
  });

  test("limits properties and reports how many more exist", () => {
    const e = make({ ...DEFAULT_LIMITS, maxProps: 2 });
    expect(e.encode({ a: 1, b: 2, c: 3 })).toMatchObject({
      props: [[{ k: "a" }], [{ k: "b" }]].map(([k]) => [k, expect.anything()]),
      more: 1,
    });
  });

  test("flags proxies without invoking traps", () => {
    let trapped = false;
    const proxy = new Proxy(
      {},
      {
        ownKeys: () => {
          trapped = true;
          return [];
        },
      },
    );
    expect(make().encode(proxy)).toMatchObject({ t: "object", ctor: "Proxy", proxy: true });
    expect(trapped).toBe(false);

    let dateTrapInvoked = false;
    const dateProxy = new Proxy(new Date(0), {
      get: () => {
        dateTrapInvoked = true;
        return undefined;
      },
    });
    expect(make().encode(dateProxy)).toMatchObject({ t: "object", ctor: "Proxy", proxy: true });
    expect(dateTrapInvoked).toBe(false);
    let fnTrapInvoked = false;
    const fnProxy = new Proxy(function target() {}, {
      get: () => {
        fnTrapInvoked = true;
        return undefined;
      },
      getOwnPropertyDescriptor: () => {
        fnTrapInvoked = true;
        return undefined;
      },
    });
    expect(make().encode(fnProxy)).toMatchObject({ t: "object", ctor: "Proxy", proxy: true });
    expect(fnTrapInvoked).toBe(false);
  });
});

describe("collections", () => {
  test("encodes arrays with holes", () => {
    // biome-ignore lint/suspicious/noSparseArray: testing holes
    expect(make().encode([1, , , 4])).toMatchObject({
      t: "array",
      length: 4,
      items: [[0, { v: "1" }], { hole: 2 }, [3, { v: "4" }]],
    });
  });

  test("encodes maps and sets", () => {
    expect(make().encode(new Map([["a", 1]]))).toMatchObject({
      t: "map",
      size: 1,
      entries: [[{ v: "a" }, { v: "1" }]],
    });
    expect(make().encode(new Set([true]))).toMatchObject({ t: "set", size: 1, items: [{ v: true }] });
  });

  test("caps entries and exposes the rest through a handle", () => {
    const e = make({ ...DEFAULT_LIMITS, maxEntries: 2 });
    const encoded = e.encode([1, 2, 3]) as { items: unknown[]; more: number; handle: string };
    expect(encoded.items).toHaveLength(2);
    expect(encoded.more).toBe(1);
    expect((e.expand(encoded.handle) as { items: unknown[] }).items).toHaveLength(3);
  });

  test("encodes typed arrays and buffers", () => {
    expect(make().encode(new BigInt64Array([1n]))).toMatchObject({
      t: "typedArray",
      ctor: "BigInt64Array",
      items: ["1"],
    });
    expect(make().encode(new Uint8Array([1, 2]).buffer)).toEqual({ t: "arrayBuffer", byteLength: 2, preview: [1, 2] });
  });

  test("keeps special numbers in typed arrays exact through JSON", () => {
    const encoded = make().encode(
      new Float64Array([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0, 1.5]),
    );
    expect(encoded).toEqual({
      t: "typedArray",
      ctor: "Float64Array",
      length: 5,
      items: ["NaN", "Infinity", "-Infinity", "-0", 1.5],
    });
    expect(JSON.parse(JSON.stringify(encoded))).toEqual(encoded);
  });
});

describe("special objects", () => {
  test("encodes dates, regexps and urls", () => {
    expect(make().encode(new Date(0))).toEqual({ t: "date", iso: "1970-01-01T00:00:00.000Z" });
    expect(make().encode(new Date(Number.NaN))).toEqual({ t: "date", iso: null });
    expect(make().encode(/a+/gi)).toEqual({ t: "regexp", source: "a+", flags: "gi" });
    expect(make().encode(new URL("https://x.dev/a"))).toEqual({ t: "url", href: "https://x.dev/a" });
  });

  test("encodes errors with causes and parsed stacks", () => {
    const err = new TypeError("bad", { cause: "root" });
    const encoded = make().encode(err) as { stack: unknown[] };
    expect(encoded).toMatchObject({ t: "error", name: "TypeError", message: "bad", cause: { t: "string", v: "root" } });
    expect(encoded.stack.length).toBeGreaterThan(0);
  });

  test("reports promise state via the peek hook", async () => {
    const resolved = Promise.resolve(1);
    await resolved;
    expect(make().encode(resolved)).toMatchObject({ t: "promise", state: "fulfilled", value: { t: "number", v: "1" } });
    expect(make().encode(new Promise(() => {}))).toMatchObject({ t: "promise", state: "pending" });
  });

  test("classifies functions", () => {
    const e = make();
    const kind = (v: unknown) => (e.encode(v) as { kind: string }).kind;
    expect(kind(() => 1)).toBe("arrow");
    expect(kind(function named() {})).toBe("function");
    expect(kind(async () => {})).toBe("async");
    expect(kind(function* () {})).toBe("generator");
    expect(kind(async function* () {})).toBe("asyncGenerator");
    expect(kind(class A {})).toBe("class");
    expect(kind(Math.max)).toBe("native");
    expect(kind(function f() {}.bind(null))).toBe("bound");
  });
});

describe("per-event size budget", () => {
  const CAP = 256 * 1024;
  const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
  const bigRows = () =>
    Array.from({ length: 1000 }, () =>
      Object.fromEntries(
        Array.from({ length: 100 }, (_, i) => [
          `k${i}`,
          Object.fromEntries(Array.from({ length: 20 }, (_, j) => [`j${j}`, j])),
        ]),
      ),
    );

  test("an oversized root value becomes a handle with a bounded preview", () => {
    const registry = new HandleRegistry();
    const e = new Encoder(registry);
    const encoded = e.encode(bigRows());
    expect(encoded).toMatchObject({ t: "handle", preview: "Array(1000)" });
    expect(bytes(encoded)).toBeLessThan(1000);
    // Handles registered while encoding the abandoned attempt are released; only the root handle remains.
    expect(registry.size).toBe(1);
  });

  test("large strings and error messages count toward the budget", () => {
    const strings = make().encode(Array.from({ length: 1000 }, () => "x".repeat(10_000)));
    expect(strings).toMatchObject({ t: "handle", preview: "Array(1000)" });
    const error = make().encode(new Error("m".repeat(1_000_000)));
    expect(error).toMatchObject({ t: "handle", preview: "Error {…}" });
  });

  test("values under the budget are encoded normally and stay under the cap", () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({ id: i, name: `row ${i}`, tags: ["a", "b"] }));
    const encoded = make().encode(rows);
    expect(encoded).toMatchObject({ t: "array", length: 100 });
    expect(bytes(encoded)).toBeLessThanOrEqual(CAP);
    const nearCap = make().encode(Array.from({ length: 1000 }, () => "y".repeat(240)));
    expect(bytes(nearCap)).toBeLessThanOrEqual(CAP);
  });

  test("an oversized root handle still expands within the expand limits", () => {
    const e = make();
    const encoded = e.encode(bigRows()) as { t: string; handle: string };
    const expanded = e.expand(encoded.handle);
    expect(expanded).toMatchObject({ t: "array", length: 1000 });
    const items = (expanded as { items: [number, { t: string; handle: string }][] }).items;
    expect(items).toHaveLength(1000);
    expect(items[0]?.[1]).toMatchObject({ t: "handle" });
    expect(e.expand(items[0]?.[1].handle ?? "")).toMatchObject({ t: "object", props: expect.any(Array) });
  });

  test("encodeMany never throws when a value leaves less than one node of budget", () => {
    const tails: unknown[] = [1, 10n, null, true, undefined, Symbol("s")];
    for (let n = 0; n <= 120; n++) {
      for (const tail of tails) {
        let out: EncodedValue[] = [];
        expect(() => {
          out = make({ ...DEFAULT_LIMITS, maxEncodedBytes: 100 }).encodeMany(["x".repeat(n), tail]);
        }).not.toThrow();
        expect(out[1]).toEqual(make().encode(tail));
      }
      let strings: EncodedValue[] = [];
      expect(() => {
        strings = make({ ...DEFAULT_LIMITS, maxEncodedBytes: 100 }).encodeMany(["x".repeat(n), "short"]);
      }).not.toThrow();
      expect(strings[1]).toMatchObject({ t: "string", v: "short" });
    }
    // The re-review's reproduction with the default limits: the array fits and leaves under 48 bytes.
    const nearCap = Array.from({ length: 1000 }, (_, i) => "y".repeat(i === 999 ? 274 : 214));
    let out: EncodedValue[] = [];
    expect(() => {
      out = make().encodeMany([nearCap, 1]);
    }).not.toThrow();
    expect(out[1]).toEqual({ t: "number", v: "1" });
  });

  test("encodeMany never throws after many oversized values", () => {
    const big = Array.from({ length: 1000 }, () => "x".repeat(10_000));
    let out: EncodedValue[] = [];
    expect(() => {
      out = make().encodeMany([...Array(2000).fill(big), 1]);
    }).not.toThrow();
    expect(out).toHaveLength(2001);
    expect(out[0]).toMatchObject({ t: "handle", preview: "Array(1000)" });
    expect(out.at(-1)).toEqual({ t: "number", v: "1" });
  });

  test("encodeMany shares one budget across the values of one event", () => {
    const e = make();
    const half = Array.from({ length: 600 }, () => "z".repeat(240));
    const [first, second, small] = e.encodeMany([half, half, 1]);
    expect(first).toMatchObject({ t: "array" });
    expect(second).toMatchObject({ t: "handle", preview: "Array(600)" });
    expect(small).toEqual({ t: "number", v: "1" });
    expect(bytes([first, second, small])).toBeLessThanOrEqual(CAP);
  });

  test("the budget counts exact JSON bytes, so escaped and non-ASCII text stays under the cap (R-M1-17(a), R-M1-18)", () => {
    const sample = 'a"\\\né€😀 ';
    expect(jsonStringBytes(sample)).toBe(Buffer.byteLength(JSON.stringify(sample)) - 2);
    expect(jsonStringBytes("\ud800")).toBe(Buffer.byteLength(JSON.stringify("\ud800")) - 2);
    expect(clipToJsonBytes("€€€", 7)).toBe("€€");
    expect(clipToJsonBytes("a😀b", 4)).toBe("a");
    // The re-review's escape-inflation repro: 800 × 240 U+0001 went out as 1.17 MB.
    const control = Array.from({ length: 800 }, () => "".repeat(240));
    const euro = Array.from({ length: 1000 }, () => "€".repeat(240));
    for (const value of [control, euro]) {
      const out = make().encodeMany([value, value, "tail"]);
      expect(bytes(out)).toBeLessThanOrEqual(CAP);
      expect(out[2]).toEqual({ t: "string", v: "tail" });
    }
  });

  test("summaries are bounded too: a flood of oversized values ends with one marker, and huge bigints and symbols are cut (R-M1-18)", () => {
    const big = Array.from({ length: 1000 }, () => "x".repeat(10_000));
    const out = make().encodeMany([...Array<unknown>(10_000).fill(big), 1]);
    expect(bytes(out)).toBeLessThanOrEqual(CAP);
    expect(out[0]).toMatchObject({ t: "handle", preview: "Array(1000)" });
    expect(out.length).toBeLessThan(10_001);
    expect(out.at(-1)).toEqual({ t: "string", v: `[${10_001 - (out.length - 1)} more values not shown]` });
    const small = { ...DEFAULT_LIMITS, maxEncodedBytes: 2048 };
    const [bigint, symbol] = make(small).encodeMany([BigInt("7".repeat(5000)), Symbol("s".repeat(5000))]);
    expect(bigint).toMatchObject({ t: "string", v: "7".repeat(100), truncated: { total: 5000 } });
    expect(symbol).toEqual({ t: "symbol", desc: "s".repeat(100) });
  });

  test("an expand reply stays under MAX_EXPAND_BYTES and pages the rest behind a handle (R-M1-17(b))", () => {
    const e = make();
    const rows = Array.from({ length: 2000 }, (_, i) => `${i}:${"x".repeat(10_000)}`);
    const { handle } = e.encode(rows) as { handle: string };
    const expanded = e.expand(handle) as {
      t: string;
      length: number;
      items: unknown[];
      more?: number;
      handle?: string;
    };
    expect(bytes(expanded)).toBeLessThanOrEqual(MAX_EXPAND_BYTES);
    expect(expanded).toMatchObject({ t: "array", length: 2000 });
    expect(expanded.items.length).toBeGreaterThan(0);
    expect(expanded.items.length + (expanded.more ?? 0)).toBe(2000);
    expect(typeof expanded.handle).toBe("string");
    const { truncated } = e.encode("".repeat(1_000_000)) as { truncated: { handle: string } };
    const text = e.expand(truncated.handle) as { v: string; truncated?: { total: number } };
    expect(bytes(text)).toBeLessThanOrEqual(MAX_EXPAND_BYTES);
    expect(text.truncated?.total).toBe(1_000_000);
  });
});

describe("parseStack", () => {
  test("parses named and anonymous frames", () => {
    const frames = parseStack(
      "Error: x\n    at run (/tmp/entry.mjs:3:9)\n    at /tmp/entry.mjs:10:1\n    at map (native)",
    );
    expect(frames).toEqual([
      { fn: "run", file: "/tmp/entry.mjs", line: 3, column: 9, user: false },
      { file: "/tmp/entry.mjs", line: 10, column: 1, user: false },
    ]);
  });
});

describe("robustness", () => {
  test("any value encodes to JSON-serializable output without throwing", () => {
    fc.assert(
      fc.property(
        fc.anything({
          withBigInt: true,
          withMap: true,
          withSet: true,
          withTypedArray: true,
          withDate: true,
          withNullPrototype: true,
          withSparseArray: true,
          withBoxedValues: true,
        }),
        (value) => {
          JSON.stringify(make().encode(value));
        },
      ),
      { numRuns: 300 },
    );
  });
});
