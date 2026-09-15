import { describe, expect, test } from "bun:test";
import { migrateSettings, parseSettings, settingsParser } from "../src/migrations";

describe("settings migrations", () => {
  test("v1 → v2 keeps user values and unknown keys and moves the untouched M1 theme to Graphite", () => {
    const s = parseSettings({
      version: 1,
      run: { autoRun: false },
      appearance: { theme: "dracula", fontSize: 18 },
      future: { flag: true },
    }) as ReturnType<typeof parseSettings> & { future?: unknown };
    expect(s.version).toBe(2);
    expect(s.run.autoRun).toBe(false);
    expect(s.appearance).toMatchObject({ theme: "graphite", fontSize: 18, darkTheme: "graphite" });
    expect(s.future).toEqual({ flag: true });
  });

  test("a hand-edited v1 theme other than the M1 default is kept", () => {
    expect(parseSettings({ version: 1, appearance: { theme: "nord" } }).appearance.theme).toBe("nord");
  });

  test("a missing version is treated as v1, and a newer file is read without migrating", () => {
    expect(migrateSettings({ appearance: { theme: "dracula" } })).toEqual({
      version: 2,
      appearance: { theme: "graphite" },
    });
    const future = parseSettings({ version: 3, editor: { lineWrap: false } });
    expect(future.version).toBe(2);
    expect(future.editor.lineWrap).toBe(false);
  });

  test("the file parser rejects non-objects so loadJson falls back to the backup", () => {
    expect(() => settingsParser.parse([1, 2])).toThrow("settings.json must contain an object");
    expect(() => settingsParser.parse("x")).toThrow();
    expect(settingsParser.parse({}).version).toBe(2);
  });
});
