import { describe, expect, test } from "bun:test";
import { DEFAULT_LIMITS, Encoder, HandleRegistry, jsonBytes } from "../src/encode";

const make = (limits = DEFAULT_LIMITS) => new Encoder(new HandleRegistry(), limits, {});

/** A plain object shaped like a DOM Element (nodeType 1), never a real DOM node (spec §5.9, Web runner only). */
function fakeElement(
  overrides: {
    tagName?: string;
    attributes?: { name: string; value: string }[];
    childNodes?: { length: number };
    outerHTML?: string;
  } = {},
) {
  const attributes = overrides.attributes ?? [];
  return {
    nodeType: 1,
    tagName: overrides.tagName ?? "DIV",
    attributes: Object.assign({ length: attributes.length }, attributes),
    childNodes: overrides.childNodes ?? { length: 0 },
    outerHTML: overrides.outerHTML ?? "<div></div>",
  };
}

describe("DOM nodes", () => {
  test("encodes a detached element as tag, attributes, child count and an outerHTML preview", () => {
    const el = fakeElement({
      tagName: "DIV",
      attributes: [
        { name: "id", value: "x" },
        { name: "class", value: "y" },
      ],
      childNodes: { length: 3 },
      outerHTML: '<div id="x" class="y">…</div>',
    });
    // el.parentNode is intentionally absent: a detached node has none, and encoding never reads it.
    expect(make().encode(el)).toEqual({
      t: "dom",
      nodeType: 1,
      tag: "DIV",
      attrs: [
        ["id", "x"],
        ["class", "y"],
      ],
      childCount: 3,
      outerHTML: '<div id="x" class="y">…</div>',
    });
  });

  test("reports the count of 1,000 children without reading any of them individually", () => {
    let indexedAccesses = 0;
    const childNodes = new Proxy(
      { length: 1000 },
      {
        get(target, prop, receiver) {
          if (prop !== "length") indexedAccesses++;
          return Reflect.get(target, prop, receiver);
        },
      },
    );
    const el = fakeElement({ childNodes: childNodes as unknown as { length: number } });
    const encoded = make().encode(el);
    expect(encoded).toMatchObject({ t: "dom", childCount: 1000 });
    expect(indexedAccesses).toBe(0);
  });

  test("caps the outerHTML preview at the string bound and expands to the full markup via a handle", () => {
    const full = `<div>${"x".repeat(20_000)}</div>`;
    const e = make();
    const encoded = e.encode(fakeElement({ outerHTML: full }));
    expect(encoded).toMatchObject({
      t: "dom",
      outerHTML: full.slice(0, DEFAULT_LIMITS.maxString),
      truncated: { total: full.length },
    });
    const handle = (encoded as { truncated: { handle: string } }).truncated.handle;
    expect(e.expand(handle)).toEqual({ t: "string", v: full });
  });

  // Each of the next three makes exactly one accessor hostile and asserts the OTHER fields still come through
  // correctly. That is what distinguishes "each field guarded independently" from a single shared try/catch
  // around all four reads: a shared catch would lose the healthy fields too the moment any one accessor throws.

  test("attributes alone hostile: childCount and outerHTML still encode correctly", () => {
    const hostile = {
      nodeType: 1,
      tagName: "DIV",
      get attributes(): never {
        throw new Error("blocked");
      },
      childNodes: { length: 5 },
      outerHTML: "<div>ok</div>",
    };
    let encoded: unknown;
    expect(() => {
      encoded = make().encode(hostile);
    }).not.toThrow();
    expect(encoded).toEqual({
      t: "dom",
      nodeType: 1,
      tag: "DIV",
      attrs: [],
      childCount: 5,
      outerHTML: "<div>ok</div>",
    });
  });

  test("childNodes alone hostile: attrs and outerHTML still encode correctly", () => {
    const hostile = {
      nodeType: 1,
      tagName: "DIV",
      attributes: Object.assign({ length: 1 }, [{ name: "id", value: "z" }]),
      get childNodes(): never {
        throw new Error("blocked");
      },
      outerHTML: "<div>ok</div>",
    };
    let encoded: unknown;
    expect(() => {
      encoded = make().encode(hostile);
    }).not.toThrow();
    expect(encoded).toEqual({
      t: "dom",
      nodeType: 1,
      tag: "DIV",
      attrs: [["id", "z"]],
      childCount: 0,
      outerHTML: "<div>ok</div>",
    });
  });

  test("outerHTML alone hostile: tag, attrs and childCount still encode correctly", () => {
    const hostile = {
      nodeType: 1,
      tagName: "DIV",
      attributes: Object.assign({ length: 1 }, [{ name: "id", value: "z" }]),
      childNodes: { length: 2 },
      get outerHTML(): never {
        throw new Error("blocked");
      },
    };
    let encoded: unknown;
    expect(() => {
      encoded = make().encode(hostile);
    }).not.toThrow();
    expect(encoded).toEqual({
      t: "dom",
      nodeType: 1,
      tag: "DIV",
      attrs: [["id", "z"]],
      childCount: 2,
      outerHTML: "",
    });
  });

  test("duck-types nodeType and tagName, so a node from an exotic document (null prototype, no shared class) still encodes", () => {
    const exotic = Object.assign(Object.create(null), fakeElement({ tagName: "SPAN" }));
    expect(() => make().encode(exotic)).not.toThrow();
    expect(make().encode(exotic)).toMatchObject({ t: "dom", tag: "SPAN", childCount: 0 });
  });

  // This exercises the generic #fit/#summary/expand machinery every object type shares (no dom-specific carve-
  // out needed), NOT rollback of #dom()'s own truncation handle: this outerHTML stays under maxString, so #dom()
  // never reaches its register branch at all — see the rollback test below for that path.
  test("a dom node too large for the per-event budget becomes a handle, like any other object", () => {
    const el = fakeElement({
      attributes: [{ name: "data-big", value: "z".repeat(500) }],
      outerHTML: `<div data-big="${"z".repeat(500)}"></div>`,
    });
    const e = make({ ...DEFAULT_LIMITS, maxEncodedBytes: 100 });
    const [encoded] = e.encodeMany([el]);
    expect(encoded).toMatchObject({ t: "handle" });
    const handle = (encoded as { handle: string }).handle;
    expect(e.expand(handle)).toMatchObject({ t: "dom", tag: "DIV" });
  });

  test("rolls back a dom node's own truncation handle when the whole node still doesn't fit the budget", () => {
    // outerHTML exceeds maxString, so #dom() registers its own truncation-string handle while producing the full
    // encoding. The budget that reproduces this can't be a literal: it must sit inside the narrow gap between the
    // encoder's internal charge *estimate* for the full value and its *actual* jsonBytes size — a gap pinned to
    // implementation details (NODE_BYTES vs. real overhead) that shifts if the dom encoding's shape ever changes.
    // So it's derived at run time instead, from a real measurement of this exact node: one byte under the real
    // size of an unconstrained encode. That stays inside the window regardless of future shape/constant changes,
    // and the register-count/registry-size assertions below fail loudly (rather than silently drifting into a
    // neighboring regime) if it ever doesn't.
    const el = fakeElement({ outerHTML: `<div>${"x".repeat(20_000)}</div>` });
    const full = new Encoder(
      new HandleRegistry(),
      { ...DEFAULT_LIMITS, maxEncodedBytes: Number.POSITIVE_INFINITY },
      {},
    ).encode(el);
    const budget = jsonBytes(full) - 1;

    const registry = new HandleRegistry();
    let registerCalls = 0;
    const register = registry.register.bind(registry);
    registry.register = (target) => {
      registerCalls++;
      return register(target);
    };
    const e = new Encoder(registry, { ...DEFAULT_LIMITS, maxEncodedBytes: budget }, {});
    const [encoded] = e.encodeMany([el]);

    expect(encoded).toMatchObject({ t: "handle" });
    // Two register() calls prove the truncation handle really was registered (not skipped for being too small to
    // even attempt): #dom()'s own truncation handle, then #summary()'s whole-node fallback handle. registry.size
    // === 1 proves the first was then rolled back rather than left to leak.
    expect(registerCalls).toBe(2);
    expect(registry.size).toBe(1);
  });
});
