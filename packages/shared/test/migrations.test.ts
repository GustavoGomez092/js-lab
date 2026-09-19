import { describe, expect, test } from "bun:test";
import { migrateSettings, parseSettings, settingsParser } from "../src/migrations";
import { SETTINGS_VERSION } from "../src/settings";

describe("settings migrations", () => {
  test("v1 → current keeps user values and unknown keys and moves the untouched M1 theme to Graphite", () => {
    const s = parseSettings({
      version: 1,
      run: { autoRun: false },
      appearance: { theme: "dracula", fontSize: 18 },
      future: { flag: true },
    }) as ReturnType<typeof parseSettings> & { future?: unknown };
    expect(s.version).toBe(SETTINGS_VERSION);
    expect(s.run.autoRun).toBe(false);
    expect(s.appearance).toMatchObject({ theme: "graphite", fontSize: 18, darkTheme: "graphite" });
    expect(s.future).toEqual({ flag: true });
  });

  test("a hand-edited v1 theme other than the M1 default is kept", () => {
    expect(parseSettings({ version: 1, appearance: { theme: "nord" } }).appearance.theme).toBe("nord");
  });

  test("a missing version is treated as v1, and a newer file is read without migrating", () => {
    expect(migrateSettings({ appearance: { theme: "dracula" } })).toEqual({
      version: SETTINGS_VERSION,
      appearance: { theme: "graphite" },
    });
    // Deliberately SETTINGS_VERSION + 1 rather than a literal: this probe has to stay genuinely *newer* than the
    // current version to test anything. It was written as a literal `4` when the current version was 3, and a
    // version bump silently turned it into a same-version file -- which migrates trivially and would have let
    // the newer-file branch rot untested.
    const future = parseSettings({ version: SETTINGS_VERSION + 1, editor: { lineWrap: false } });
    expect(future.version).toBe(SETTINGS_VERSION);
    expect(future.editor.lineWrap).toBe(false);
  });

  test("v2 → v3 keeps every v2 value and fills the npm and build sections", () => {
    const s = parseSettings({ version: 2, editor: { lineWrap: false }, build: { pipelineOperator: true } });
    expect(s.version).toBe(SETTINGS_VERSION);
    expect(s.editor.lineWrap).toBe(false);
    expect(s.build.pipelineOperator).toBe(true);
    expect(s.npm.allowInstallScripts).toBe(false);
  });

  /**
   * The step this milestone added. Without a `3` entry in SETTINGS_MIGRATIONS, `migrateSettings` THROWS for every
   * existing v3 settings.json -- which `loadJson` treats as a corrupt file and replaces with defaults, so every
   * setting the user had is silently reset. That is what this test guards, which is why it asserts on a v3 input
   * specifically rather than on "some old version".
   */
  test("v3 → v4 bumps the version, keeps every v3 value and fills the ai section", () => {
    expect(migrateSettings({ version: 3 })).toEqual({ version: 4 });
    const s = parseSettings({ version: 3, editor: { lineWrap: false }, npm: { allowInstallScripts: true } });
    expect(s.version).toBe(SETTINGS_VERSION);
    expect(s.editor.lineWrap).toBe(false);
    expect(s.npm.allowInstallScripts).toBe(true);
    expect(s.ai.provider).toBe("none");
    expect(s.ai.includeOutput).toBe(true);
  });

  test("the file parser rejects non-objects so loadJson falls back to the backup", () => {
    expect(() => settingsParser.parse([1, 2])).toThrow("settings.json must contain an object");
    expect(() => settingsParser.parse("x")).toThrow();
    expect(settingsParser.parse({}).version).toBe(SETTINGS_VERSION);
  });
});
