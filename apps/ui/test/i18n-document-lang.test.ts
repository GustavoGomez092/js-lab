import { describe, expect, test } from "bun:test";
import { SOURCE_LOCALE } from "@jslab/shared";
import { applyDocumentLocale, currentLocale } from "../src/i18n";

/**
 * `<html lang>` is what a screen reader uses to choose a voice, so leaving it at the static `en` in
 * index.html/settings.html mispronounces four of the five shipped locales.
 *
 * This is genuinely testable, unlike anything about layout: `lang` is an attribute, not a measurement, and
 * happy-dom models attributes exactly. What it does NOT prove is that the two entry points call it -- that is
 * one line each in main.tsx and settings-main.tsx, covered by no test here (see the task report).
 */
describe("the page's lang attribute follows the locale (spec §17)", () => {
  test("applying the locale overwrites whatever the static markup declared", () => {
    // Seeded to a value neither the markup nor the locale would produce, so the assertion fails if the
    // function stops writing rather than passing because `en` happened to be there already.
    document.documentElement.lang = "xx";
    applyDocumentLocale();
    expect(document.documentElement.lang).toBe(currentLocale());
    expect(document.documentElement.lang).toBe(SOURCE_LOCALE);
  });

  test("a locale other than the source one is written through unchanged", () => {
    // The test page carries no `?lng=`, so `currentLocale()` is always `en` here; without an explicit locale
    // a version that hardcoded "en" would pass the test above.
    document.documentElement.lang = "xx";
    applyDocumentLocale(document, "ja");
    expect(document.documentElement.lang).toBe("ja");
    applyDocumentLocale(document, "pt");
    expect(document.documentElement.lang).toBe("pt");
  });
});
