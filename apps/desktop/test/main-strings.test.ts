import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTranslator } from "../src/main/i18n";
import { createStrings, strings as installed, installStrings } from "../src/main/strings";

const LOCALES = join(import.meta.dir, "..", "..", "ui", "src", "i18n", "locales");
const strings = createStrings(createTranslator({ dir: LOCALES, locale: "en" }));

describe("Main's strings, resolved through t() (spec §17)", () => {
  test("plain strings keep their English text", () => {
    expect(strings.window.settingsTitle).toBe("JSLab Settings");
    expect(strings.log.restartRequested).toBe("Restart in Safe Mode requested");
    expect(strings.notices.unexpectedError).toBe("Something went wrong. Choose Help → Copy Debug Log to report it.");
    expect(strings.files.expired).toBe("That file request expired. Open the file again.");
  });

  test("interpolated strings keep theirs, with no unreplaced placeholder", () => {
    // No `strings.dialogs`: the startup dialog fires before a translator exists and shows an English literal
    // from index.ts by design, so the catalogue entry it used to carry had no surface and was removed.
    expect(strings.files.tooLarge("big.ts")).toBe("big.ts is larger than 50 MB and can't be opened.");
    expect(strings.runs.workingDirectoryNotFound("/tmp/x")).toBe("Working directory not found: /tmp/x");
    expect(strings.notices.settingsNewer(9)).toContain("version 9");
    // The leading space is load-bearing: this is appended to a recovery sentence in startup-notices.ts.
    expect(strings.notices.copySaved("settings.corrupt-1.json")).toBe(" A copy was saved as settings.corrupt-1.json");
    for (const value of [
      strings.log.safeMode("shift"),
      strings.log.quitFlushTimedOut(5000),
      strings.notices.copySaved("settings.corrupt-1.json"),
      strings.notices.sessionNewer(4),
    ]) {
      expect(value).not.toContain("{{");
    }
  });

  /**
   * The plan names one interpolated parameter per string; these two take more, and a template that dropped one
   * would still render -- just with a `{{maxBytes}}` left in the middle of a sentence the user is meant to act on.
   */
  test("the multi-parameter strings interpolate every one of their parameters", () => {
    expect(strings.log.npmNpmrcTooLarge("/d/.npmrc", 99, 50)).toBe(
      "npm's .npmrc at /d/.npmrc is 99 bytes, over the 50-byte limit, and was not read",
    );
    const tooLarge = strings.notices.settingsTooLarge(900, 800);
    expect(tooLarge).toContain("(900 bytes; the limit is 800)");
    expect(tooLarge).not.toContain("{{");
  });

  test("both session plurals select by count", () => {
    expect(strings.notices.tabsDropped(1)).toContain("1 tab in session.json");
    expect(strings.notices.tabsDropped(3)).toContain("3 tabs in session.json");
    // The second plural the extraction found: one unreadable buffer reads "tab's", several read "tabs'".
    expect(strings.notices.buffersUnreadable(1)).toBe(
      "1 tab's contents couldn't be read, so it opened empty and read-only. JSLab won't save it over its file.",
    );
    expect(strings.notices.buffersUnreadable(3)).toBe(
      "3 tabs' contents couldn't be read, so they opened empty and read-only. JSLab won't save them over their files.",
    );
  });

  test("every key resolves -- none falls through to its own name", () => {
    // createTranslator returns the key when nothing matches, so a typo shows up as a dotted path. Function
    // leaves are called too: a mistyped key inside one is invisible to a walk that only reads strings.
    const unresolved: string[] = [];
    const walk = (value: unknown, path: string): void => {
      if (typeof value === "string") {
        if (/^main(\.[a-zA-Z]+)+$/.test(value)) unresolved.push(`${path} -> ${value}`);
      } else if (typeof value === "function") {
        const rendered = (value as (...args: unknown[]) => string)(...Array(value.length).fill(1));
        if (/^main(\.[a-zA-Z]+)+$/.test(rendered)) unresolved.push(`${path} -> ${rendered}`);
      } else if (typeof value === "object" && value !== null) {
        for (const [name, child] of Object.entries(value)) walk(child, `${path}.${name}`);
      }
    };
    walk(strings, "strings");
    expect(unresolved).toEqual([]);
  });
});

describe("the module-scope `strings` binding (17 Main modules import it)", () => {
  /**
   * The default exists so that importing any Main module gives English without a bootstrap. It resolves through a
   * locales directory this module locates on its own, so this test is the guard on that path: if the repo layout
   * moves, every Main string silently becomes its own key and only this fails.
   */
  test("resolves English before anything installs a translator", () => {
    expect(installed.window.settingsTitle).toBe("JSLab Settings");
    expect(installed.files.tooLarge("big.ts")).toBe("big.ts is larger than 50 MB and can't be opened.");
  });

  test("installStrings replaces it for every importer, through the ES live binding", () => {
    const dir = mkdtempSync(join(tmpdir(), "jslab-main-strings-"));
    try {
      writeFileSync(join(dir, "en.json"), JSON.stringify({ main: { window: { settingsTitle: "Ajustes" } } }));
      installStrings(createTranslator({ dir, locale: "en" }));
      // Re-imported rather than captured: this is what the other 16 modules see.
      const { strings: after } = require("../src/main/strings") as { strings: typeof installed };
      expect(after.window.settingsTitle).toBe("Ajustes");
    } finally {
      // Restored so this file cannot change what any other desktop test reads from the same module registry.
      installStrings(createTranslator({ dir: LOCALES, locale: "en" }));
      rmSync(dir, { recursive: true, force: true });
    }
    const { strings: restored } = require("../src/main/strings") as { strings: typeof installed };
    expect(restored.window.settingsTitle).toBe("JSLab Settings");
  });
});
