import { describe, expect, test } from "bun:test";
import { migrateSettings, parseSettings, settingsParser } from "../src/migrations";

describe("settings migrations", () => {
  test("v1 → v3 keeps user values and unknown keys and moves the untouched M1 theme to Graphite", () => {
    const s = parseSettings({
      version: 1,
      run: { autoRun: false },
      appearance: { theme: "dracula", fontSize: 18 },
      future: { flag: true },
    }) as ReturnType<typeof parseSettings> & { future?: unknown };
    expect(s.version).toBe(3);
    expect(s.run.autoRun).toBe(false);
    expect(s.appearance).toMatchObject({ theme: "graphite", fontSize: 18, darkTheme: "graphite" });
    expect(s.future).toEqual({ flag: true });
  });

  test("a hand-edited v1 theme other than the M1 default is kept", () => {
    expect(parseSettings({ version: 1, appearance: { theme: "nord" } }).appearance.theme).toBe("nord");
  });

  test("a missing version is treated as v1, and a newer file is read without migrating", () => {
    expect(migrateSettings({ appearance: { theme: "dracula" } })).toEqual({
      version: 3,
      appearance: { theme: "graphite" },
    });
    const future = parseSettings({ version: 4, editor: { lineWrap: false } });
    expect(future.version).toBe(3);
    expect(future.editor.lineWrap).toBe(false);
  });

  test("v2 → v3 keeps every v2 value and fills the npm and build sections", () => {
    const s = parseSettings({ version: 2, editor: { lineWrap: false }, build: { pipelineOperator: true } });
    expect(s.version).toBe(3);
    expect(s.editor.lineWrap).toBe(false);
    expect(s.build.pipelineOperator).toBe(true);
    expect(s.npm.allowInstallScripts).toBe(false);
    expect(migrateSettings({ version: 2 })).toEqual({ version: 3 });
  });

  test("the file parser rejects non-objects so loadJson falls back to the backup", () => {
    expect(() => settingsParser.parse([1, 2])).toThrow("settings.json must contain an object");
    expect(() => settingsParser.parse("x")).toThrow();
    expect(settingsParser.parse({}).version).toBe(3);
  });
});
