import { describe, expect, test } from "bun:test";
import { DEFAULT_LIMITS, Encoder, HandleRegistry } from "../src/encode";

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

  test("never throws when tagName, attributes, childNodes or outerHTML accessors throw", () => {
    const hostile = {
      nodeType: 1,
      tagName: "DIV",
      get attributes(): never {
        throw new Error("blocked");
      },
      get childNodes(): never {
        throw new Error("blocked");
      },
      get outerHTML(): never {
        throw new Error("blocked");
      },
    };
    let encoded: unknown;
    expect(() => {
      encoded = make().encode(hostile);
    }).not.toThrow();
    expect(encoded).toEqual({ t: "dom", nodeType: 1, tag: "DIV", attrs: [], childCount: 0, outerHTML: "" });
  });

  test("duck-types nodeType and tagName, so a node from an exotic document (null prototype, no shared class) still encodes", () => {
    const exotic = Object.assign(Object.create(null), fakeElement({ tagName: "SPAN" }));
    expect(() => make().encode(exotic)).not.toThrow();
    expect(make().encode(exotic)).toMatchObject({ t: "dom", tag: "SPAN", childCount: 0 });
  });

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
});
