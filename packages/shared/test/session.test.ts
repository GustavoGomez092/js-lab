import { describe, expect, test } from "bun:test";
import {
  bufferFileName,
  closedBufferFileName,
  createTab,
  defaultSession,
  MAX_CLOSED_TABS,
  normalizeSession,
  parseSession,
  SESSION_VERSION,
  sessionParser,
  sessionSchema,
  TAB_ID_PATTERN,
  tabLayoutSchema,
} from "../src/session";
import { defaultSettings } from "../src/settings";

const tab = (id: string) => createTab({ id });

describe("session", () => {
  test("default session has exactly one active tab", () => {
    const s = defaultSession(() => tab("t1"));
    expect(s.tabOrder).toEqual(["t1"]);
    expect(s.activeTabId).toBe("t1");
    expect(s.tabs.t1).toMatchObject({ title: "Untitled", language: "typescript", runtime: "bun" });
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

  test("a window frame below 400×300 is clamped to that size instead of forgotten; a malformed one becomes null (FA-m6)", () => {
    expect(sessionSchema.parse({ window: { x: 5, y: 6, width: 10, height: 10 } }).window).toEqual({
      x: 5,
      y: 6,
      width: 400,
      height: 300,
    });
    expect(sessionSchema.parse({ window: { x: "0", y: 0, width: 800, height: 600 } }).window).toBeNull();
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

  test("M2 tab fields default, and the closed stack drops invalid entries and keeps at most 20", () => {
    const s = sessionSchema.parse({
      tabs: { a: { id: "a" } },
      closedStack: [
        { tab: { id: "c1" }, closedAt: 5 },
        { tab: {} },
        ...Array.from({ length: 30 }, (_, i) => ({ tab: { id: `x${i}` }, closedAt: i })),
      ],
    });
    expect(s.tabs.a).toMatchObject({
      filePath: null,
      lastSavedHash: null,
      workingDirectory: null,
      gistId: null,
      viewState: null,
      layout: { orientation: "horizontal", editorSize: 55, outputVisible: true },
    });
    expect(s.closedStack).toHaveLength(MAX_CLOSED_TABS);
    expect(s.closedStack[0]?.tab.id).toBe("c1");
    expect([s.settingsWindow, s.lastDirectory]).toEqual([null, null]);
    expect(closedBufferFileName({ id: "c1", language: "jsx" })).toBe("closed/c1.jsx");
    const frame = { x: 1, y: 2, width: 800, height: 600 };
    expect(sessionSchema.parse({ window: frame }).window).toEqual(frame);
    expect(sessionSchema.parse({ window: { ...frame, displayId: "2", fullscreen: true } }).window).toEqual({
      ...frame,
      displayId: "2",
      fullscreen: true,
    });
    expect(sessionSchema.parse({ window: { ...frame, displayId: 7, fullscreen: "yes" } }).window).toEqual(frame);
  });

  test("normalize drops tabs stored under a key that is not their id", () => {
    const s = normalizeSession(sessionSchema.parse({ tabOrder: ["a", "b"], tabs: { a: tab("a"), b: tab("zzz") } }));
    expect(s.tabOrder).toEqual(["a"]);
  });

  test("closed-stack entries with unsafe ids are dropped even when no open tab needs a repair (FA-m1)", () => {
    const { session, repairedTabIds } = parseSession({
      version: 2,
      tabOrder: ["ok"],
      activeTabId: "ok",
      tabs: { ok: tab("ok") },
      closedStack: [
        { tab: tab("../../escape"), closedAt: 2 },
        { tab: tab("kept"), closedAt: 1 },
      ],
    });
    expect(repairedTabIds).toEqual([]);
    expect(session.closedStack.map((entry) => entry.tab.id)).toEqual(["kept"]);
  });

  test("hand-edited tab ids outside the safe id format get fresh ids everywhere they are referenced (R-M1-18)", () => {
    const { session, repairedTabIds } = parseSession({
      version: 2,
      tabOrder: ["ok", "my tab", "../x"],
      activeTabId: "my tab",
      tabs: { ok: tab("ok"), "my tab": tab("my tab"), "../x": tab("../x") },
    });
    const [first, spaced = "", dotted = ""] = session.tabOrder;
    expect(first).toBe("ok");
    for (const id of session.tabOrder) expect(id).toMatch(TAB_ID_PATTERN);
    expect(session.activeTabId).toBe(spaced);
    expect(session.tabs[spaced]?.id).toBe(spaced);
    expect(repairedTabIds).toEqual([
      ["my tab", spaced],
      ["../x", dotted],
    ]);
  });

  test("a tab's working directory survives a v2 round trip with no migration (M3 decision 1)", () => {
    const tab = createTab({ id: "t1", workingDirectory: "/work/api" });
    const written = JSON.parse(JSON.stringify({ ...defaultSession(() => tab), version: SESSION_VERSION }));
    expect(parseSession(written).session.tabs.t1?.workingDirectory).toBe("/work/api");
    expect(
      parseSession({ version: 2, tabOrder: ["t2"], activeTabId: "t2", tabs: { t2: { id: "t2" } } }).session.tabs.t2
        ?.workingDirectory,
    ).toBeNull();
    expect(SESSION_VERSION).toBe(4);
  });

  test("layout.tiles defaults independently via .catch(), and the v2 → v3 migration is a no-op bump (R-M4-T8-VERSION-1)", () => {
    // A v2 session (pre-Task 8) has no `tiles` at all; migrating it only bumps the version -- tiles comes from
    // tabLayoutSchema's own .catch() default, not from a data transform (mirrors v1 → v2's own no-op precedent).
    const migrated = parseSession({
      version: 2,
      tabOrder: ["a"],
      activeTabId: "a",
      tabs: { a: { id: "a", layout: { orientation: "horizontal", editorSize: 55, outputVisible: true } } },
    });
    expect(migrated.fileVersion).toBe(2);
    expect(migrated.session.version).toBe(SESSION_VERSION);
    expect(migrated.session.tabs.a?.layout.tiles).toEqual({ webviewVisible: false, consoleSize: 55 });

    // Each tiles field still defaults on its own: an out-of-range `consoleSize` resets only `consoleSize` and
    // leaves a valid `webviewVisible` alone -- what lets a field be added beside `tiles` with no second bump.
    const partiallyBad = tabLayoutSchema.parse({
      orientation: "horizontal",
      editorSize: 55,
      outputVisible: true,
      tiles: { webviewVisible: true, consoleSize: 500 },
    });
    expect(partiallyBad.tiles).toEqual({ webviewVisible: true, consoleSize: 55 });
  });

  // R-WEBVIEW-TAB-1: `arrangement` and `order` are retired. The Web View is always the bottom area now (or the
  // whole panel, which is a UI-level view choice, not a stored one), so there is nothing left for them to say.
  test("a v3 session carrying the retired tiles.arrangement / tiles.order loads without error onto the new shape", () => {
    const migrated = parseSession({
      version: 3,
      tabOrder: ["a"],
      activeTabId: "a",
      tabs: {
        a: {
          id: "a",
          layout: {
            orientation: "horizontal",
            editorSize: 55,
            outputVisible: true,
            // Exactly what a session written by the previous build could contain: the non-default arrangement AND
            // a reversed order, the two shapes most likely to survive on a real user's disk.
            tiles: {
              arrangement: "side-by-side",
              order: ["webview", "console"],
              webviewVisible: true,
              consoleSize: 40,
            },
            muted: false,
          },
        },
      },
    });

    expect(migrated.fileVersion).toBe(3);
    expect(migrated.session.version).toBe(SESSION_VERSION);
    // Both retired keys are gone -- `tabTilesSchema` is a plain `z.object`, which strips what it does not name --
    // and the two fields that still mean something are carried across untouched, NOT reset to their defaults.
    // `toEqual` rather than `toMatchObject` is the point: a surviving `arrangement` key would fail this.
    expect(migrated.session.tabs.a?.layout.tiles).toEqual({ webviewVisible: true, consoleSize: 40 });
    // The rest of the layout is undisturbed by the bump.
    expect(migrated.session.tabs.a?.layout.muted).toBe(false);
    expect(migrated.session.tabs.a?.layout.editorSize).toBe(55);
  });

  test("a session from a newer build reads layout.tiles with defaults rather than being discarded (downgrade case)", () => {
    const future = parseSession({
      version: SESSION_VERSION + 1,
      tabOrder: ["a"],
      activeTabId: "a",
      tabs: { a: { id: "a" } },
      somethingFromTheFuture: true,
    });
    expect(future.newerThanBuild).toBe(true);
    expect(future.session.version).toBe(SESSION_VERSION + 1);
    expect(future.session.tabs.a?.layout.tiles).toEqual({ webviewVisible: false, consoleSize: 55 });
    expect((future.session as Record<string, unknown>).somethingFromTheFuture).toBe(true);
  });

  test("layout.muted defaults to false and lives beside tiles under the same v3 bump (Task 15)", () => {
    // A v2 session has neither `tiles` nor `muted`; migrating it is still a no-op version bump, and `muted`
    // comes from tabLayoutSchema's own .catch() default, exactly like `tiles` did in Task 8.
    const migrated = parseSession({
      version: 2,
      tabOrder: ["a"],
      activeTabId: "a",
      tabs: { a: { id: "a", layout: { orientation: "horizontal", editorSize: 55, outputVisible: true } } },
    });
    expect(migrated.session.tabs.a?.layout.muted).toBe(false);
  });

  test("an invalid layout.muted falls back to false without discarding tiles or the other layout fields", () => {
    const parsed = tabLayoutSchema.parse({
      orientation: "vertical",
      editorSize: 40,
      outputVisible: false,
      tiles: { webviewVisible: true, consoleSize: 30 },
      muted: "yes",
    });
    expect(parsed).toEqual({
      orientation: "vertical",
      editorSize: 40,
      outputVisible: false,
      tiles: { webviewVisible: true, consoleSize: 30 },
      muted: false,
    });
    // A valid `true` is preserved.
    expect(tabLayoutSchema.parse({ muted: true }).muted).toBe(true);
  });
});
