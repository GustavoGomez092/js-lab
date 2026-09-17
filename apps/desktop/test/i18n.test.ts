import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTranslator, interpolate } from "../src/main/i18n";

let dir = "";

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "jslab-i18n-"));
  writeFileSync(
    join(dir, "en.json"),
    JSON.stringify({
      menu: { file: "File", quit: "Quit {{app}}" },
      notices: {
        tabsDropped_one: "{{count}} tab was skipped",
        tabsDropped_other: "{{count}} tabs were skipped",
        // Deliberately NOT pluralized, though it interpolates `count`: not every counted string needs two forms.
        queued: "{{count}} queued",
      },
      onlyInEnglish: "Fallback me",
    }),
  );
  writeFileSync(
    join(dir, "ja.json"),
    JSON.stringify({
      menu: { file: "ファイル", quit: "{{app}} を終了" },
      notices: { tabsDropped_other: "{{count}} 個のタブをスキップしました" },
    }),
  );
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("Main's small t() (spec §17)", () => {
  test("returns the locale's string, and falls back to en key by key", () => {
    const t = createTranslator({ dir, locale: "ja" });
    expect(t("menu.file")).toBe("ファイル");
    // ja.json has no `onlyInEnglish`: spec §17 says missing keys fall back to `en`.
    expect(t("onlyInEnglish")).toBe("Fallback me");
  });

  test("interpolates named variables", () => {
    expect(createTranslator({ dir, locale: "ja" })("menu.quit", { app: "JSLab" })).toBe("JSLab を終了");
    expect(interpolate("a {{x}} b {{x}} c", { x: 1 })).toBe("a 1 b 1 c");
    // An unknown placeholder is left verbatim rather than blanked, so the gap is visible in a bug report.
    expect(interpolate("hi {{missing}}", {})).toBe("hi {{missing}}");
  });

  test("selects a plural form from `count`, falling back to en when the locale lacks the form", () => {
    const ja = createTranslator({ dir, locale: "ja" });
    const en = createTranslator({ dir, locale: "en" });
    expect(en("notices.tabsDropped", { count: 1 })).toBe("1 tab was skipped");
    expect(en("notices.tabsDropped", { count: 3 })).toBe("3 tabs were skipped");
    expect(ja("notices.tabsDropped", { count: 3 })).toBe("3 個のタブをスキップしました");
    // ja.json defines only `_other`; `_one` has to fall back to English rather than vanish.
    expect(ja("notices.tabsDropped", { count: 1 })).toBe("1 tab was skipped");
    // A `count` must not make an unpluralized key unreachable: the plural form is tried first, the plain key
    // still answers. Without the plain candidate every counted-but-singular string renders as its own key.
    expect(en("notices.queued", { count: 2 })).toBe("2 queued");
    expect(ja("notices.queued", { count: 1 })).toBe("1 queued");
  });

  test("an unknown key returns the key, so a mistake is visible and never blank", () => {
    expect(createTranslator({ dir, locale: "en" })("no.such.key")).toBe("no.such.key");
    // `menu` resolves to an object, not a string. Returning it would hand a non-string to the interpolator and
    // throw during menu construction -- the one thing this module must never do.
    expect(createTranslator({ dir, locale: "en" })("menu")).toBe("menu");
    // A key that walks *through* a string ("menu.file" is a leaf) is a miss, not a crash.
    expect(createTranslator({ dir, locale: "en" })("menu.file.deeper")).toBe("menu.file.deeper");
  });

  test("loads each file once, through the injected `read`, and reads only `en` when `en` is the locale", () => {
    const seen: string[] = [];
    const spy = (path: string): string => {
      seen.push(path);
      return readFileSync(path, "utf8");
    };
    const en = createTranslator({ dir, locale: "en", read: spy });
    expect(en("menu.file")).toBe("File");
    expect(en("menu.quit", { app: "JSLab" })).toBe("Quit JSLab");
    // Read at construction, not per call -- t() is called once per menu item on every menu rebuild. And `en` is
    // already the fallback locale, so it is never loaded twice.
    expect(seen).toEqual([join(dir, "en.json")]);

    const jaSeen: string[] = [];
    const ja = createTranslator({
      dir,
      locale: "ja",
      read: (path) => {
        jaSeen.push(path);
        return readFileSync(path, "utf8");
      },
    });
    expect(ja("menu.file")).toBe("ファイル");
    expect(jaSeen).toEqual([join(dir, "ja.json"), join(dir, "en.json")]);
  });

  test("a missing or corrupt locale folder degrades to keys instead of throwing", () => {
    // This runs while the window and the native menu are being built. A throw here costs the user the app.
    const missing = createTranslator({ dir: join(dir, "nope"), locale: "ja" });
    expect(missing("menu.file")).toBe("menu.file");
    const corrupt = mkdtempSync(join(tmpdir(), "jslab-i18n-bad-"));
    writeFileSync(join(corrupt, "en.json"), "{ not json");
    expect(createTranslator({ dir: corrupt, locale: "en" })("menu.file")).toBe("menu.file");
    rmSync(corrupt, { recursive: true, force: true });
  });
});
