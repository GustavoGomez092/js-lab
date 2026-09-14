import { describe, expect, test } from "bun:test";
import {
  bufferFileName,
  createTab,
  defaultSession,
  normalizeSession,
  parseSession,
  SESSION_VERSION,
  sessionParser,
  sessionSchema,
} from "../src/session";
import { defaultSettings } from "../src/settings";

const tab = (id: string) => createTab({ id });

describe("session", () => {
  test("default session has exactly one active tab", () => {
    const s = defaultSession(() => tab("t1"));
    expect(s.tabOrder).toEqual(["t1"]);
    expect(s.activeTabId).toBe("t1");
    expect(s.tabs.t1).toMatchObject({ title: "Untitled", language: "typescript", runtime: "browser-node" });
    expect(s.window).toBeNull();
  });

  test("new tabs use the settings defaults for runtime and language (spec §7.3, §8)", () => {
    const defaults = defaultSettings().run;
    expect(createTab()).toMatchObject({ runtime: defaults.defaultRuntime, language: defaults.defaultLanguage });
    expect(sessionSchema.parse({ tabs: { a: { id: "a", runtime: "deno" } } }).tabs.a?.runtime).toBe(
      defaults.defaultRuntime,
    );
  });

  test("normalize drops unknown and duplicate ids, appends unordered tabs and fixes the active tab", () => {
    const s = normalizeSession(
      sessionSchema.parse({
        tabOrder: ["missing", "a", "a"],
        activeTabId: "missing",
        tabs: { a: tab("a"), b: tab("b") },
      }),
    );
    expect(s.tabOrder).toEqual(["a", "b"]);
    expect(s.activeTabId).toBe("a");
  });

  test("normalize creates a tab when none exist", () => {
    const s = normalizeSession(sessionSchema.parse({ tabs: {} }), () => tab("fresh"));
    expect(s.tabOrder).toEqual(["fresh"]);
  });

  test("invalid tab fields fall back to defaults", () => {
    const s = sessionSchema.parse({ tabs: { a: { id: "a", language: "cobol", layout: { editorSize: 500 } } } });
    expect(s.tabs.a).toMatchObject({ language: "typescript", layout: { orientation: "horizontal", editorSize: 55 } });
  });

  test("an invalid window frame becomes null", () => {
    expect(sessionSchema.parse({ window: { x: 0, y: 0, width: 10, height: 10 } }).window).toBeNull();
  });

  test("buffer file names use the language extension", () => {
    expect(bufferFileName({ id: "a", language: "tsx" })).toBe("a.tsx");
    expect(bufferFileName({ id: "b", language: "javascript" })).toBe("b.js");
  });

  test("one invalid tab is dropped and reported without losing the other tabs (final review I4)", () => {
    const { session, droppedTabs } = parseSession({
      version: 1,
      tabOrder: ["a", "bad"],
      tabs: { a: tab("a"), bad: { title: "no id" } },
    });
    expect(Object.keys(session.tabs)).toEqual(["a"]);
    expect(droppedTabs).toEqual(["bad"]);
  });

  test("versions: an M1 file migrates to the current version, and a newer file keeps its version and unknown keys (I4)", () => {
    const m1 = parseSession({ version: 1, tabs: { a: tab("a") } });
    expect([m1.fileVersion, m1.newerThanBuild, m1.session.version]).toEqual([1, false, SESSION_VERSION]);
    expect(parseSession({ tabs: {} }).fileVersion).toBe(1);
    const newer = parseSession({ version: SESSION_VERSION + 1, tabs: {}, workspaces: [{ id: "w" }] });
    expect([newer.fileVersion, newer.newerThanBuild, newer.session.version]).toEqual([
      SESSION_VERSION + 1,
      true,
      SESSION_VERSION + 1,
    ]);
    expect((newer.session as Record<string, unknown>).workspaces).toEqual([{ id: "w" }]);
    expect(() => sessionParser.parse([])).toThrow("session.json must contain an object");
  });
});
