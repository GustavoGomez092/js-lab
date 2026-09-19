import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { appNoticeSchema, noticeSeverity } from "@jslab/rpc-schema";
import { defaultSettings, mergeSettings, type Settings } from "@jslab/shared";
import { createTranslator } from "../src/main/i18n";
import { languageChangeNotice } from "../src/main/startup-notices";
import { createStrings } from "../src/main/strings";

const strings = createStrings(
  createTranslator({ dir: join(import.meta.dir, "..", "..", "ui", "src", "i18n", "locales"), locale: "en" }),
);
// Not `string`: `DeepPartial<Settings>` narrows this to the UI_LANGUAGES union, so the plan's own spelling of
// this helper (`uiLanguage: string`) does not typecheck.
const withLanguage = (uiLanguage: Settings["app"]["uiLanguage"]) =>
  mergeSettings(defaultSettings(), { app: { uiLanguage } });

describe("the restart notice (spec §17: a notice is shown)", () => {
  test("a language change produces a notice naming the restart", () => {
    const notice = languageChangeNotice(withLanguage("en"), withLanguage("ja"), strings);
    expect(notice?.id).toBe("languageChanged");
    // Against the catalogue rather than a substring: the shipped English begins "Restart JSLab…", so the
    // plan's draft assertion (`toContain("restart")`, lower case) could not have matched it.
    expect(notice?.message).toBe(strings.notices.languageChanged);
    expect(notice?.message).toMatch(/restart/i);
  });

  test("any other settings change produces none", () => {
    const before = withLanguage("en");
    const after = mergeSettings(before, { editor: { lineWrap: false } });
    expect(languageChangeNotice(before, after, strings)).toBeNull();
    // mergeSettings re-parses the whole object, so every change yields a new `app` object. Comparing the
    // field, not the object identity, is what keeps this from firing on unrelated writes.
    expect(languageChangeNotice(before, withLanguage("en"), strings)).toBeNull();
  });

  test("the notice survives the app.notice contract the UI re-validates", () => {
    // `app.notice` is the one Main -> UI message the UI parses before showing (FA-I3), so an id Main can
    // raise but `STARTUP_NOTICE_IDS` does not list is dropped without a trace -- the notice would simply
    // never appear, which is indistinguishable from never having been sent.
    const notice = languageChangeNotice(withLanguage("en"), withLanguage("zh"), strings);
    expect(notice).not.toBeNull();
    if (!notice) return;
    const parsed = appNoticeSchema.parse(notice);
    expect(parsed.id).toBe("languageChanged");
    // Nothing is broken and nothing was lost, so this speaks in the quietest voice -- which also means it
    // dismisses itself after NOTICE_AUTO_DISMISS_MS, unlike a warning or an error.
    expect(noticeSeverity(parsed)).toBe("info");
  });
});
