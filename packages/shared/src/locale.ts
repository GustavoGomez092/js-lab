import type { UI_LANGUAGES } from "./settings";

/** `app.uiLanguage` (spec §8): the five shipped locales plus `system`. */
export type UiLanguage = (typeof UI_LANGUAGES)[number];

/** Spec §17 v1 locales: `en` (source), `es`, `ja`, `zh`, `pt`. */
export const LOCALES = ["en", "es", "ja", "zh", "pt"] as const;
export type Locale = (typeof LOCALES)[number];

/** The locale every other one falls back to, key by key (spec §17). */
export const SOURCE_LOCALE: Locale = "en";

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/**
 * The locale a window opens in (spec §8, §17). `system` reads the OS language; anything we don't ship,
 * and any unreadable value, resolves to `en` -- this runs during window creation, where throwing would
 * cost the user their app rather than their translation.
 *
 * A system locale arrives in several shapes: Intl gives `ja-JP`, POSIX `LANG` gives `es_ES.UTF-8`, and a
 * script subtag gives `zh-Hans-CN`. Only the primary subtag is significant here, because we ship no
 * region- or script-specific variants.
 */
export function resolveLocale(uiLanguage: string, systemLocale: string | undefined): Locale {
  if (isLocale(uiLanguage)) return uiLanguage;
  if (uiLanguage !== "system" || !systemLocale) return SOURCE_LOCALE;
  const [primary] = systemLocale.toLowerCase().split(/[-_.]/);
  return isLocale(primary) ? primary : SOURCE_LOCALE;
}
