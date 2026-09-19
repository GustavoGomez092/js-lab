import { isLocale, type Locale, SOURCE_LOCALE } from "@jslab/shared";
import i18next from "i18next";
import en from "./locales/en.json";
import es from "./locales/es.json";
import ja from "./locales/ja.json";
import pt from "./locales/pt.json";
import zh from "./locales/zh.json";

/**
 * The locale files are imported, not fetched: the CSP (spec §18) permits no `connect-src` that could load
 * one at runtime, and a static import lets Vite bundle all five into the view -- which is also what makes
 * `t()` usable at module scope, before the first render.
 */
const resources = {
  en: { translation: en },
  es: { translation: es },
  ja: { translation: ja },
  pt: { translation: pt },
  zh: { translation: zh },
};

/**
 * The locale Main put on the URL (spec §17). Anything absent or unknown is English, so a page opened by
 * hand -- without Main's `?lng=` -- still renders.
 */
export function localeFromSearch(search: string): Locale {
  // URLSearchParams strips a leading "?" itself, so both "?lng=ja" and "lng=ja" parse.
  const value = new URLSearchParams(search).get("lng");
  return isLocale(value) ? value : SOURCE_LOCALE;
}

const locale = localeFromSearch(typeof location === "undefined" ? "" : location.search);

// Synchronous: no backend and no language detector, so the catalogue is in place the moment this module
// finishes evaluating -- and therefore before `strings.ts`, which imports this one, evaluates its own body.
void i18next.init({
  lng: locale,
  // Spec §17: "missing keys fall back to `en`", key by key rather than whole-catalogue.
  fallbackLng: SOURCE_LOCALE,
  resources,
  // React escapes on render; escaping here too would show "Browser &amp; Node APIs" to the user.
  interpolation: { escapeValue: false },
});

export function currentLocale(): Locale {
  return locale;
}

/**
 * Sets `<html lang>` from the locale (spec §17). Both pages declare a static `lang="en"`, which is right for
 * the default and wrong for the other four: this attribute is what a screen reader uses to choose a voice, so
 * a Japanese UI left at `lang="en"` is read aloud by an English voice.
 *
 * Both parameters are injectable so a test can watch it do something. The test page's own URL carries no
 * `?lng=`, so `currentLocale()` is always the source locale there -- an implementation that ignored the locale
 * entirely and hardcoded `en` would be indistinguishable without an explicit one to pass in.
 */
export function applyDocumentLocale(doc: Document = document, locale: Locale = currentLocale()): void {
  doc.documentElement.lang = locale;
}

/** A missing key renders as the key itself -- i18next's own default, and better than a blank label. */
export function t(key: string, vars?: Record<string, string | number>): string {
  return i18next.t(key, vars ?? {});
}
