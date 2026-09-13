import { describe, expect, test } from "bun:test";
import { types } from "node:util";
import fc from "fast-check";
import { DEFAULT_LIMITS, Encoder, HandleRegistry, parseStack } from "../src/encode";

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
