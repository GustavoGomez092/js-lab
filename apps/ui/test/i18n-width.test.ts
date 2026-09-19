import { describe, expect, test } from "bun:test";
import { LOCALES } from "@jslab/shared";
import { flattenKeys } from "../src/i18n/check";
import en from "../src/i18n/locales/en.json";
import es from "../src/i18n/locales/es.json";
import ja from "../src/i18n/locales/ja.json";
import pt from "../src/i18n/locales/pt.json";
import zh from "../src/i18n/locales/zh.json";
import { checkWidths, displayWidth, WIDTH_BUDGETS } from "../src/i18n/width";

const tables: Record<string, unknown> = { en, es, ja, pt, zh };

describe("displayWidth", () => {
  test("counts CJK and fullwidth characters as two columns", () => {
    expect(displayWidth("File")).toBe(4);
    expect(displayWidth("ファイル")).toBe(8);
    expect(displayWidth("文件")).toBe(4);
    // Two wide ideographs plus U+2026 HORIZONTAL ELLIPSIS, whose East Asian Width is Ambiguous and which this
    // function therefore counts as one -- five columns, not six. (The M5e plan's draft of this test asserted 6,
    // which its own implementation could never produce.)
    expect(displayWidth("設定…")).toBe(5);
    expect(displayWidth("")).toBe(0);
  });

  test("counts a Latin accent as one column whether it is precomposed or combining", () => {
    // Both spellings must agree, or the same Portuguese string scores differently depending on how the
    // translator's editor happened to normalise it. The NFD forms are what exercise the combining-mark
    // branch at all: the precomposed strings never reach it, so on their own they prove nothing about it.
    expect(displayWidth("Ações")).toBe(5);
    expect(displayWidth("Disposición")).toBe(11);
    expect(displayWidth("Ações".normalize("NFD"))).toBe(5);
    expect(displayWidth("Disposición".normalize("NFD"))).toBe(11);
    expect(displayWidth("Á")).toBe(1);
  });
});

describe("width budgets (a proxy for the Graphite layout, not a measurement of it)", () => {
  test("the budgets cover the width-critical controls and nothing is budgeted at zero", () => {
    // A budget of 0 would make every string violate, and an empty map would make none -- either way the
    // suite would stop meaning anything. Assert the real size: 27 today, ratcheted rather than approximated
    // so that quietly dropping a control's budget is a failing diff and not a silent loss of coverage.
    expect(Object.keys(WIDTH_BUDGETS).length).toBeGreaterThanOrEqual(27);
    expect(Object.values(WIDTH_BUDGETS).every((budget) => budget >= 4)).toBe(true);
  });

  test("every budgeted key really exists in en.json, so no budget is a silent no-op", () => {
    // `checkWidths` skips a key the table does not define, which is right for a partly-translated locale and
    // dangerous for the budget map itself: a typo like `settings.tab.general` checks nothing whatsoever and
    // every other test in this file still passes. This is the assertion that makes the map honest.
    const present = new Set(flattenKeys(en));
    expect(Object.keys(WIDTH_BUDGETS).filter((key) => !present.has(key))).toEqual([]);
  });

  test("English itself is within budget -- the budgets are not aspirational", () => {
    expect(checkWidths(en, WIDTH_BUDGETS)).toEqual([]);
  });

  test("every shipped locale stays within budget for the keys it translated", () => {
    for (const locale of LOCALES) {
      expect({ locale, violations: checkWidths(tables[locale], WIDTH_BUDGETS) }).toEqual({
        locale,
        violations: [],
      });
    }
  });

  test("a label that outgrows its control is reported, not silently accepted", () => {
    const violations = checkWidths({ menu: { file: "Un nombre larguísimo para un menú" } }, { "menu.file": 12 });
    expect(violations).toEqual([{ key: "menu.file", width: 33, budget: 12 }]);
  });

  test("a key the locale has not translated yet is skipped, not reported as zero-width", () => {
    // The control for the test above: four of the five shipped locales define only a seeded fraction of the
    // catalogue, so "absent" has to mean "falls back to en, already in budget" rather than "violates".
    expect(checkWidths({}, { "menu.file": 4 })).toEqual([]);
    expect(checkWidths({ menu: {} }, { "menu.file": 4 })).toEqual([]);
    // A key whose value is a group rather than a string is also not a label, and must not be measured.
    expect(checkWidths({ menu: { file: { nested: "File" } } }, { "menu.file": 1 })).toEqual([]);
  });
});
