import { describe, expect, test } from "bun:test";
import { nest, plainLeaves, remapSettingsFields } from "../scripts/i18n-extract";

describe("plainLeaves", () => {
  test("collects string leaves by dotted path and skips functions", () => {
    const source = { a: "A", b: { c: "C", d: (x: string) => x }, e: 7 };
    expect(plainLeaves(source)).toEqual({ a: "A", "b.c": "C" });
  });

  test("keeps a dotted object key whole, so setting keys survive the walk", () => {
    // strings.settings.fields uses "editor.lineWrap" as a literal object key.
    const source = { settings: { fields: { "editor.lineWrap": { label: "Line Wrap" } } } };
    expect(plainLeaves(source)).toEqual({ "settings.fields.editor.lineWrap.label": "Line Wrap" });
  });
});

describe("remapSettingsFields (spec §17 key convention)", () => {
  test("drops the `fields` segment so keys read settings.editor.lineWrap.label", () => {
    expect(
      remapSettingsFields({
        "settings.fields.editor.lineWrap.label": "Line Wrap",
        "settings.fields.editor.lineWrap.help": "Wrap long lines to the editor width.",
        "settings.tabs.general": "General",
      }),
    ).toEqual({
      "settings.editor.lineWrap.label": "Line Wrap",
      "settings.editor.lineWrap.help": "Wrap long lines to the editor width.",
      "settings.tabs.general": "General",
    });
  });

  test("leaves every other namespace untouched", () => {
    expect(remapSettingsFields({ "shell.run": "Run" })).toEqual({ "shell.run": "Run" });
  });
});

describe("nest", () => {
  test("builds the nested shape en.json holds", () => {
    expect(nest({ "shell.run": "Run", "format.busy": "Formatting…" })).toEqual({
      shell: { run: "Run" },
      format: { busy: "Formatting…" },
    });
  });

  test("throws on a key-prefix collision instead of silently destroying a translation", () => {
    // `a.b` cannot be both a string and the parent of `a.b.c`. The naive walk overwrote the
    // string with {} and lost it with no error; a lost translation must never be silent.
    expect(() => nest({ "a.b": "Leaf", "a.b.c": "Deeper" })).toThrow(/key collision/);
    expect(() => nest({ "a.b.c": "Deeper", "a.b": "Leaf" })).toThrow(/key collision/);
  });
});
