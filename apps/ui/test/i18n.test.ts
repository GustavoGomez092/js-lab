import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LOCALES, SOURCE_LOCALE } from "@jslab/shared";
import i18next from "i18next";
import { currentLocale, localeFromSearch, t } from "../src/i18n";

const LOCALES_DIR = join(import.meta.dir, "..", "src", "i18n", "locales");
const MODULE = join(import.meta.dir, "..", "src", "i18n", "index.ts");

/**
 * Evaluates the module in a fresh process, which is the only way to observe what it does at module scope:
 * inside this file it has already been imported once, under this page's own (empty) URL.
 */
const probe = (preamble: string): { locale: string; title: string } => {
  const script = `${preamble}
    const { currentLocale, t } = await import(${JSON.stringify(MODULE)});
    console.log(JSON.stringify({ locale: currentLocale(), title: t("app.settingsWindowTitle") }));`;
  const run = Bun.spawnSync([process.execPath, "-e", script], { cwd: join(import.meta.dir, "..") });
  if (run.exitCode !== 0) throw new Error(`probe exited ${run.exitCode}: ${run.stderr.toString()}`);
  return JSON.parse(run.stdout.toString()) as { locale: string; title: string };
};

const shippedTitle = (locale: string): string => {
  const file = JSON.parse(readFileSync(join(LOCALES_DIR, `${locale}.json`), "utf8")) as {
    app?: { settingsWindowTitle?: unknown };
  };
  const title = file.app?.settingsWindowTitle;
  if (typeof title !== "string") throw new Error(`${locale}.json is missing a string app.settingsWindowTitle`);
  return title;
};

describe("localeFromSearch (spec §17)", () => {
  test("reads a locale we ship out of the query string", () => {
    expect(localeFromSearch("?lng=ja")).toBe("ja");
    expect(localeFromSearch("?lng=pt&other=1")).toBe("pt");
    expect(localeFromSearch("lng=es")).toBe("es");
  });

  test("falls back to en for anything absent, empty or unknown", () => {
    // Main always supplies ?lng=, but a developer opening the page by hand must still get a working app.
    expect(localeFromSearch("")).toBe(SOURCE_LOCALE);
    expect(localeFromSearch("?lng=")).toBe(SOURCE_LOCALE);
    expect(localeFromSearch("?lng=de")).toBe(SOURCE_LOCALE);
    // `system` is an app.uiLanguage value, not a locale: Main resolves it before it ever reaches the URL.
    expect(localeFromSearch("?lng=system")).toBe(SOURCE_LOCALE);
  });
});

describe("the UI translator", () => {
  test("is initialized at module scope, before any component renders", () => {
    // strings.ts is imported at module scope across the app. If init were deferred, every one of those
    // importers would read an empty catalogue. This asserts the ordering the whole design depends on.
    expect(currentLocale()).toBe(SOURCE_LOCALE);
    expect(t("app.name")).toBe("JSLab");
  });

  test("hands i18next the locale from the URL, not a hardcoded one", () => {
    // Without this, `lng:` could be wired to any constant and every other assertion here would still pass,
    // because the test page's own search string is empty and so resolves to the source locale anyway.
    expect(i18next.language).toBe(currentLocale());
  });

  test("returns the key for an unknown key rather than an empty string", () => {
    expect(t("no.such.key")).toBe("no.such.key");
  });

  test("interpolates without HTML-escaping, because React renders the result as text", () => {
    // escapeValue must be off: React escapes on render, and double-escaping would show `&amp;` to the
    // user in strings like "Browser & Node APIs". Registered here rather than shipped in en.json so the
    // assertion runs against the real configured instance without putting a test key in the catalogue.
    i18next.addResourceBundle(SOURCE_LOCALE, "translation", { test: { amp: "Browser {{sym}} Node" } }, true, true);
    expect(t("test.amp", { sym: "&" })).toBe("Browser & Node");
    expect(t("app.name", {})).toBe("JSLab");
    expect(t("no.such.key", { x: "a & b" })).toBe("no.such.key");
  });

  test("falls back to en for a key a translated catalogue is missing (spec §17)", () => {
    // The five catalogues will drift while Task 12 fills them in. A key present only in en must render as
    // English everywhere, never as a raw key -- that is what `fallbackLng` buys and nothing else pins it.
    i18next.addResourceBundle(SOURCE_LOCALE, "translation", { test: { onlyEn: "English only" } }, true, true);
    expect(i18next.t("test.onlyEn", { lng: "ja" })).toBe("English only");
  });

  test("bundles every shipped catalogue, each under its own locale", () => {
    // Catches both a catalogue left out of `resources` and one wired to the wrong import -- a mistake the
    // en-only assertions above cannot see, since they never ask for a non-source locale.
    for (const locale of LOCALES) {
      expect(i18next.t("app.settingsWindowTitle", { lng: locale })).toBe(shippedTitle(locale));
    }
  });

  test("takes its locale from the page URL, end to end", () => {
    // Every other assertion in this file runs on a page whose search string is empty, where the URL locale
    // and the source locale are the same value -- so a version that ignored the URL, or hardcoded "en",
    // passes all of them. This one opens the module under a URL asking for Japanese and reads back the
    // catalogue that actually came out.
    expect(probe(`globalThis.location = { search: "?lng=ja" };`)).toEqual({
      locale: "ja",
      title: shippedTitle("ja"),
    });
  });

  test("still initializes where there is no `location` at all", () => {
    // strings.ts is reachable from tooling that runs outside a browser, where a bare `location.search`
    // would throw a ReferenceError and take the whole import graph down with it.
    expect(probe("")).toEqual({ locale: SOURCE_LOCALE, title: shippedTitle(SOURCE_LOCALE) });
  });
});
