import { describe, expect, test } from "bun:test";
import { isLocale, LOCALES, resolveLocale, SOURCE_LOCALE, UI_LANGUAGES } from "../src";

describe("resolveLocale (spec §8 app.uiLanguage, §17)", () => {
  test("LOCALES is UI_LANGUAGES minus `system`, with en as the source", () => {
    expect(LOCALES).toEqual(["en", "es", "ja", "zh", "pt"]);
    expect(SOURCE_LOCALE).toBe("en");
    expect([...UI_LANGUAGES]).toEqual(["system", ...LOCALES]);
  });

  test("an explicit language wins over the system locale", () => {
    for (const locale of LOCALES) expect(resolveLocale(locale, "ja-JP")).toBe(locale);
  });

  test("`system` takes the OS language when we ship it, ignoring region and case", () => {
    expect(resolveLocale("system", "ja-JP")).toBe("ja");
    expect(resolveLocale("system", "pt-BR")).toBe("pt");
    expect(resolveLocale("system", "es_ES.UTF-8")).toBe("es");
    expect(resolveLocale("system", "ZH-Hans-CN")).toBe("zh");
    expect(resolveLocale("system", "en")).toBe("en");
  });

  test("anything unrecognised, empty or absent falls back to en rather than throwing", () => {
    // A user with a Finnish Mac must get English, not a crash at window creation.
    expect(resolveLocale("system", "fi-FI")).toBe("en");
    expect(resolveLocale("system", undefined)).toBe("en");
    expect(resolveLocale("system", "")).toBe("en");
    expect(resolveLocale("system", "C")).toBe("en");
    // settings.json is repaired by zod before this is called, but Main also reads it at window
    // creation time, so a junk value must still be survivable.
    expect(resolveLocale("klingon", "ja-JP")).toBe("en");
  });

  test("isLocale accepts exactly the five shipped locales", () => {
    expect(LOCALES.every(isLocale)).toBe(true);
    expect(isLocale("system")).toBe(false);
    expect(isLocale("de")).toBe(false);
    expect(isLocale(undefined)).toBe(false);
  });
});
