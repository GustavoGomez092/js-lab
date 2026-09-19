import { describe, expect, test } from "bun:test";
import type { EncodedValue } from "@jslab/rpc-schema";
import { copyEntriesToClipboard, entryCopyText } from "../src/output/copy";
import { entryToJson, entryToJsonText, entryToText, valueToJson } from "../src/output/text";
import type { DisplayEvent } from "../src/state/output";

describe("copyEntriesToClipboard", () => {
  test("reports a failed clipboard write instead of throwing", async () => {
    const failing = { writeText: () => Promise.reject(new Error("denied")) };
    await expect(copyEntriesToClipboard("text", failing)).resolves.toBe("failed");

    let received: string | undefined;
    const working = {
      writeText: (text: string) => {
        received = text;
        return Promise.resolve();
      },
    };
    await expect(copyEntriesToClipboard("hello", working)).resolves.toBe("copied");
    expect(received).toBe("hello");
  });
});

const result = (value: EncodedValue): DisplayEvent =>
  ({ kind: "result", line: 1, source: "autolog", value, seq: 1, t: 0 }) as DisplayEvent;

describe("valueToJson (OU-10)", () => {
  // The whole point of the conversion: these are the values `JSON.stringify` either throws on or silently
  // drops. Literal expectations, not a re-derivation through `format.ts` -- a test that asked `formatPrimitive`
  // what to expect would agree with the implementation even if both were wrong.
  test("values JSON cannot hold become the text the row displays, never undefined and never a throw", () => {
    expect(valueToJson({ t: "undefined" })).toBe("undefined");
    expect(valueToJson({ t: "symbol", desc: "tag" })).toBe("Symbol(tag)");
    expect(valueToJson({ t: "bigint", v: "9007199254740993" })).toBe("9007199254740993n");
    expect(valueToJson({ t: "circular", ref: 1 })).toBe("[Circular]");
    expect(valueToJson({ t: "weak", kind: "WeakMap" })).toBe("WeakMap { <items unknown> }");
    expect(valueToJson({ t: "function", name: "greet", kind: "function", handle: "h1" })).toBe("ƒ greet()");
    expect(valueToJson({ t: "getter", handle: "h2" })).toBe("(...)");
    expect(valueToJson({ t: "handle", handle: "h3", preview: "Big {…}" })).toBe("Big {…}");
    expect(valueToJson({ t: "promise", id: 1, state: "pending" })).toBe("Promise { <pending> }");
    expect(valueToJson({ t: "regexp", source: "a.c", flags: "gi" })).toBe("/a.c/gi");
  });

  test("a DOM node becomes its displayed markup rather than an empty object", () => {
    const dom: EncodedValue = {
      t: "dom",
      nodeType: 1,
      tag: "DIV",
      attrs: [["id", "root"]],
      childCount: 2,
      outerHTML: '<div id="root"></div>',
    };
    expect(valueToJson(dom)).toBe('<div id="root"> (2 children)');
  });

  test("non-finite numbers keep their spelling instead of collapsing to null", () => {
    expect(valueToJson({ t: "number", v: "42" })).toBe(42);
    expect(valueToJson({ t: "number", v: "NaN" })).toBe("NaN");
    expect(valueToJson({ t: "number", v: "Infinity" })).toBe("Infinity");
    expect(valueToJson({ t: "number", v: "-Infinity" })).toBe("-Infinity");
    expect(valueToJson({ t: "number", v: "-0" })).toBe("-0");
  });

  test("structured values become their JSON-native counterparts", () => {
    expect(
      valueToJson({
        t: "object",
        id: 1,
        ctor: "Object",
        props: [
          [{ k: "name" }, { t: "string", v: "Ada" }],
          [{ k: "on" }, { t: "boolean", v: true }],
          [{ k: "missing" }, { t: "undefined" }],
        ],
      }),
    ).toEqual({ name: "Ada", on: true, missing: "undefined" });

    expect(
      valueToJson({
        t: "array",
        id: 2,
        ctor: "Array",
        length: 3,
        items: [[0, { t: "number", v: "1" }], { hole: 1 }, [2, { t: "null" }]],
      }),
    ).toEqual([1, null, null]);

    expect(valueToJson({ t: "set", id: 3, size: 2, items: [{ t: "number", v: "7" }, { t: "null" }] })).toEqual([
      7,
      null,
    ]);

    // Pairs, so the distinct Map keys 1 and "1" cannot collapse onto one property name.
    expect(
      valueToJson({
        t: "map",
        id: 4,
        size: 2,
        entries: [
          [
            { t: "number", v: "1" },
            { t: "string", v: "num" },
          ],
          [
            { t: "string", v: "1" },
            { t: "string", v: "str" },
          ],
        ],
      }),
    ).toEqual([
      [1, "num"],
      ["1", "str"],
    ]);

    expect(valueToJson({ t: "date", iso: "2020-01-02T03:04:05.000Z" })).toBe("2020-01-02T03:04:05.000Z");
    expect(valueToJson({ t: "date", iso: null })).toBe("Invalid Date");
    expect(valueToJson({ t: "url", href: "https://example.com/a" })).toBe("https://example.com/a");
    expect(valueToJson({ t: "headers", entries: [["content-type", "text/plain"]] })).toEqual({
      "content-type": "text/plain",
    });
  });

  test("an error keeps its name, message and user frames", () => {
    expect(
      valueToJson({
        t: "error",
        name: "TypeError",
        message: "boom",
        stack: [{ fn: "load", line: 4, column: 9, user: true }],
      }),
    ).toEqual({ name: "TypeError", message: "boom", stack: ["at load (L4:9)"] });
  });
});

describe("entryToJson / entryToJsonText (OU-10)", () => {
  test("a lone console argument copies as itself; several copy as a list", () => {
    const one = { kind: "console", level: "log", groupDepth: 0, args: [{ t: "string", v: "hi" }], seq: 1, t: 0 };
    expect(entryToJson(one as DisplayEvent)).toBe("hi");
    const many = {
      kind: "console",
      level: "log",
      groupDepth: 0,
      args: [
        { t: "string", v: "hi" },
        { t: "number", v: "2" },
      ],
      seq: 1,
      t: 0,
    };
    expect(entryToJson(many as DisplayEvent)).toEqual(["hi", 2]);
  });

  test("stdout copies its text without the trailing newline, as the plain-text path does", () => {
    expect(entryToJson({ kind: "stdout", text: "raw\n", seq: 1, t: 0 } as DisplayEvent)).toBe("raw");
  });

  test("an error row copies its name, message and user frames only", () => {
    const event = {
      kind: "error",
      phase: "runtime",
      name: "TypeError",
      message: "boom",
      line: 4,
      stack: [
        { fn: "load", line: 4, column: 9, user: true },
        { fn: "internal", file: "/bun/internal.js", line: 1, column: 1, user: false },
      ],
      seq: 1,
      t: 0,
    } as DisplayEvent;
    expect(entryToJson(event)).toEqual({ name: "TypeError", message: "boom", stack: ["at load (L4:9)"] });
  });

  // The two failure modes this feature must never have: a thrown exception on right-click, and the literal
  // text "undefined" landing on the clipboard because `JSON.stringify` returned nothing.
  test("every hostile value still produces parseable JSON text", () => {
    const hostile: EncodedValue[] = [
      { t: "undefined" },
      { t: "symbol", desc: "s" },
      { t: "bigint", v: "10" },
      { t: "circular", ref: 1 },
      { t: "function", name: "f", kind: "arrow", handle: "h" },
      { t: "number", v: "NaN" },
      { t: "weak", kind: "WeakSet" },
      {
        t: "object",
        id: 1,
        ctor: "Object",
        props: [
          [{ k: "fn" }, { t: "function", name: "f", kind: "function", handle: "h" }],
          [{ sym: "tag" }, { t: "undefined" }],
        ],
      },
    ];
    for (const value of hostile) {
      const text = entryToJsonText(result(value));
      expect(typeof text).toBe("string");
      expect(text).not.toBe("undefined");
      expect(() => JSON.parse(text)).not.toThrow();
    }
    // A function-valued property survives as a property rather than being dropped the way JSON.stringify drops it.
    const object = hostile[hostile.length - 1] as EncodedValue;
    expect(JSON.parse(entryToJsonText(result(object)))).toEqual({ fn: "ƒ f()", "[Symbol(tag)]": "undefined" });
  });

  test("the copied JSON is indented", () => {
    expect(entryToJsonText(result({ t: "object", id: 1, ctor: "Object", props: [[{ k: "a" }, { t: "null" }]] }))).toBe(
      '{\n  "a": null\n}',
    );
  });
});

describe("entryCopyText (OU-10)", () => {
  test("the two menu items copy different things: the row's text, and its value as JSON", () => {
    const event = result({ t: "string", v: "hi" });
    expect(entryCopyText(event, "text")).toBe("hi");
    expect(entryCopyText(event, "json")).toBe('"hi"');
    // The text path stays exactly what Copy All already puts on the clipboard for this row.
    expect(entryCopyText(event, "text")).toBe(entryToText(event));
  });
});
