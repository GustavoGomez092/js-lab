import { describe, expect, test } from "bun:test";
import { LOCALES, SOURCE_LOCALE } from "@jslab/shared";
import { flattenKeys } from "../src/i18n/check";
import coverage from "../src/i18n/coverage.json";
import en from "../src/i18n/locales/en.json";
import es from "../src/i18n/locales/es.json";
import ja from "../src/i18n/locales/ja.json";
import pt from "../src/i18n/locales/pt.json";
import zh from "../src/i18n/locales/zh.json";

const tables: Record<string, unknown> = { en, es, ja, pt, zh };
/**
 * Keys every non-English locale must really translate. Two entries differ from the plan's draft list, each for
 * the same reason the plan itself gives for excluding `settings.tabs.npm` -- an assertion that can never hold:
 *
 * - `menu.view` is a GROUP in en.json, not a leaf: the View menu's own label is `menu.view._` (the `_`
 *   convention documented in docs/user/translating.md). `valueAt` returns null for the group, so the plan's
 *   spelling fails `toBeTypeOf("string")` no matter how complete the translation is.
 * - `settings.tabs.general` is "General" in English AND "General" in Spanish -- the correct Spanish word. The
 *   "not still English" assertion would fail on a right answer, exactly as it would for `NPM`. Replaced with
 *   `settings.tabs.formatting`, which is genuinely distinct in all four languages.
 */
const SEEDED = ["menu.file", "menu.edit", "menu.view._", "menu.help", "settings.tabs.formatting", "commands.run.start"];

describe("the seeded locales (spec §17)", () => {
  test("every shipped locale has a file, and none has a key en lacks", () => {
    const enKeys = new Set(flattenKeys(en));
    for (const locale of LOCALES) {
      expect(tables[locale]).toBeDefined();
      const extra = flattenKeys(tables[locale]).filter((key) => !enKeys.has(key));
      expect({ locale, extra }).toEqual({ locale, extra: [] });
    }
  });

  test("each non-English locale really translated the seeded keys", () => {
    const enFlat = Object.fromEntries(flattenKeys(en).map((key) => [key, valueAt(en, key)]));
    for (const locale of LOCALES) {
      if (locale === SOURCE_LOCALE) continue;
      for (const key of SEEDED) {
        const value = valueAt(tables[locale], key);
        expect(value, `${locale} is missing ${key}`).toBeTypeOf("string");
        // A verbatim copy of the English is not a translation, and the coverage count must not credit it.
        expect(value, `${locale}.${key} is still English`).not.toBe(enFlat[key]);
      }
    }
  });

  test("coverage.json matches what is on disk, so the regression gate has real numbers", () => {
    const enFlat = Object.fromEntries(flattenKeys(en).map((key) => [key, valueAt(en, key)]));
    for (const locale of LOCALES) {
      if (locale === SOURCE_LOCALE) continue;
      const translated = flattenKeys(tables[locale]).filter((key) => valueAt(tables[locale], key) !== enFlat[key]);
      expect({ locale, count: (coverage as Record<string, number>)[locale] }).toEqual({
        locale,
        count: translated.length,
      });
      expect(translated.length).toBeGreaterThanOrEqual(SEEDED.length);
    }
  });

  test("no translated string dropped or renamed a placeholder from its English original", () => {
    // The classic regression: "Saved {{name}}" becomes "Guardado" and the filename silently disappears.
    const placeholders = (value: string) => [...value.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();
    for (const locale of LOCALES) {
      if (locale === SOURCE_LOCALE) continue;
      for (const key of flattenKeys(tables[locale])) {
        const source = valueAt(en, key.replace(/_(one|other|zero|two|few|many)$/, "_other"));
        const translated = valueAt(tables[locale], key);
        if (typeof source !== "string" || typeof translated !== "string") continue;
        expect({ locale, key, has: placeholders(translated) }).toEqual({
          locale,
          key,
          has: placeholders(source),
        });
      }
    }
  });
});

function valueAt(table: unknown, key: string): string | null {
  let node: unknown = table;
  for (const segment of key.split(".")) {
    if (typeof node !== "object" || node === null) return null;
    node = (node as Record<string, unknown>)[segment];
  }
  return typeof node === "string" ? node : null;
}
