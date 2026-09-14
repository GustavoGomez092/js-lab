import { describe, expect, test } from "bun:test";
import type { BootstrapPayload, RunEvent } from "@jslab/rpc-schema";
import {
  createTab,
  defaultSession,
  defaultSettings,
  mergeSettings,
  normalizeSession,
  sessionSchema,
} from "@jslab/shared";
import { createAppStore, shouldAutoRun } from "../src/state/store";

function payload(overrides: Partial<BootstrapPayload> = {}): BootstrapPayload {
  return {
    settings: defaultSettings(),
    session: defaultSession(() => createTab({ id: "t1", title: "scratch" })),
    buffers: { t1: "1 + 1" },
    safeMode: { active: false, reason: null },
    versions: { app: "0.0.1", bun: "1.3.13" },
    ...overrides,
  };
}

const log = (seq: number): RunEvent => ({ kind: "console", level: "log", groupDepth: 0, args: [], seq, t: 0 });

describe("app store", () => {
  test("hydrate loads the active tab and its buffer without arming auto-run", () => {
    const store = createAppStore();
    store.getState().hydrate(payload());
    const s = store.getState();
    expect(s.ready).toBe(true);
    expect(s.tab?.id).toBe("t1");
    expect(s.code).toBe("1 + 1");
    expect(s.autoRunArmed).toBe(false);
    expect(shouldAutoRun(s)).toBe(false);
  });

  test("runtime notices from Main are added once per id and capped at the 5 newest (FA-I3)", () => {
    const store = createAppStore();
    store.getState().hydrate(payload({ notices: [{ id: "settingsNewer", message: "newer" }] }));
    store.getState().addNotice({ id: "unexpectedError", message: "Something went wrong." });
    store.getState().addNotice({ id: "unexpectedError", message: "Something went wrong." });
    expect(store.getState().notices.map((n) => n.id)).toEqual(["settingsNewer", "unexpectedError"]);
    store.getState().dismissNotice("unexpectedError");
    store.getState().addNotice({ id: "unexpectedError", message: "Something went wrong." });
    expect(store.getState().notices.map((n) => n.id)).toEqual(["settingsNewer", "unexpectedError"]);

    const full = createAppStore();
    const ids = ["settingsRecovered", "sessionRecovered", "settingsNewer", "sessionNewer", "tabsDropped"] as const;
    full.getState().hydrate(payload({ notices: ids.map((id) => ({ id, message: id })) }));
    full.getState().addNotice({ id: "unexpectedError", message: "Something went wrong." });
    expect(full.getState().notices.map((n) => n.id)).toEqual([...ids.slice(1), "unexpectedError"]);
  });

  test("the first edit arms auto-run", () => {
    const store = createAppStore();
    store.getState().hydrate(payload());
    store.getState().editCode("2 + 2");
    expect(store.getState().code).toBe("2 + 2");
    expect(shouldAutoRun(store.getState())).toBe(true);
  });

  test("auto-run stays off in safe mode and when disabled in settings", () => {
    const safe = createAppStore();
    safe.getState().hydrate(payload({ safeMode: { active: true, reason: "crashLoop" } }));
    safe.getState().editCode("x");
    expect(shouldAutoRun(safe.getState())).toBe(false);

    const disabled = createAppStore();
    disabled.getState().hydrate(payload({ settings: mergeSettings(defaultSettings(), { run: { autoRun: false } }) }));
    disabled.getState().editCode("x");
    expect(shouldAutoRun(disabled.getState())).toBe(false);
  });

  test("run events and states flow through the output reducer", () => {
    const store = createAppStore();
    store.getState().receiveState("r1", "transpiling");
    store.getState().receiveEvents("r1", [log(1), log(2)]);
    store.getState().receiveState("r1", "idle");
    expect(store.getState().output.entries).toHaveLength(2);
    expect(store.getState().output.runState).toBe("idle");
    store.getState().clearOutput();
    expect(store.getState().output.entries).toEqual([]);
  });

  test("diagnostics are kept only for the current run and reset when a new run starts", () => {
    const store = createAppStore();
    const warning = { severity: "warning" as const, code: "magic-comment-no-value", message: "m", line: 1, column: 1 };
    store.getState().receiveState("r1", "transpiling");
    store.getState().receiveDiagnostics("r1", [warning]);
    store.getState().receiveDiagnostics("old", []);
    expect(store.getState().diagnostics).toEqual([warning]);
    store.getState().receiveState("r2", "transpiling");
    expect(store.getState().diagnostics).toEqual([]);
  });

  test("reveal requests carry an increasing nonce so repeated clicks re-trigger", () => {
    const store = createAppStore();
    store.getState().reveal(4);
    store.getState().reveal(4);
    expect(store.getState().revealRequest).toEqual({ line: 4, nonce: 2 });
  });

  test("layout changes are clamped and toggle orientation", () => {
    const store = createAppStore();
    store.getState().hydrate(payload());
    store.getState().setEditorSize(99);
    store.getState().toggleOrientation();
    expect(store.getState().tab?.layout).toEqual({ orientation: "vertical", editorSize: 90, outputVisible: true });
  });

  test("hydrate loads every tab with its own buffer and output, and switching swaps the mirrors", () => {
    const store = createAppStore();
    const session = normalizeSession(
      sessionSchema.parse({
        tabOrder: ["a", "b"],
        activeTabId: "b",
        tabs: { a: createTab({ id: "a" }), b: createTab({ id: "b" }) },
        closedStack: [{ tab: createTab({ id: "c" }), closedAt: 1 }],
      }),
    );
    store.getState().hydrate(payload({ session, buffers: { a: "1", b: "2" } }));
    expect([store.getState().activeTabId, store.getState().code, store.getState().closedCount]).toEqual(["b", "2", 1]);
    store.getState().receiveState("r1", "transpiling", undefined, "a");
    store.getState().receiveEvents("r1", [log(1)], "a");
    expect(store.getState().output.entries).toHaveLength(0);
    store.getState().activateTab("a");
    expect([store.getState().code, store.getState().output.entries.length]).toEqual(["1", 1]);
  });

  test("openTab inserts after the active tab; removing the last tab clears the mirrors", () => {
    const store = createAppStore();
    store.getState().hydrate(payload());
    store.getState().openTab(createTab({ id: "t2" }), "two");
    store.getState().activateTab("t1");
    store.getState().openTab(createTab({ id: "t3" }), "three");
    expect(store.getState().tabOrder).toEqual(["t1", "t3", "t2"]);
    store.getState().removeTab("t3");
    expect(store.getState().activeTabId).toBe("t2");
    store.getState().removeTab("t2");
    store.getState().removeTab("t1");
    expect([store.getState().activeTabId, store.getState().tab, store.getState().code]).toEqual([null, null, ""]);
  });

  test("rename, Main tab updates and reorder", () => {
    const store = createAppStore();
    store.getState().hydrate(payload());
    store.getState().setViewState("t1", { scrollTop: 40 });
    store.getState().renameTab("t1", "  mine ");
    expect(store.getState().tab).toMatchObject({ title: "mine", titleIsCustom: true });
    store.getState().applyTabUpdate(createTab({ id: "t1", filePath: "/a.ts", lastSavedHash: "h" }));
    expect(store.getState().tab).toMatchObject({ filePath: "/a.ts", viewState: { scrollTop: 40 } });
    store.getState().openTab(createTab({ id: "t2" }), "");
    store.getState().reorderTabs(["t2"]);
    expect(store.getState().tabOrder).toEqual(["t1", "t2"]);
    store.getState().reorderTabs(["t2", "t1"]);
    expect(store.getState().tabOrder).toEqual(["t2", "t1"]);
  });

  test("focus, modal, output filter, status message, cursor and editor size reset", () => {
    const store = createAppStore();
    store.getState().hydrate(payload());
    store.getState().setFocus("output");
    store.getState().openModal({ kind: "palette", context: "output" });
    store.getState().setOutputFilter("errors");
    store.getState().setStatusMessage("Formatted");
    store.getState().setCursor({ line: 3, column: 9 });
    store.getState().setEditorSize(80);
    store.getState().resetEditorSize();
    const s = store.getState();
    expect([s.focus, s.modal?.kind, s.outputFilter, s.statusMessage, s.cursor, s.tab?.layout.editorSize]).toEqual([
      "output",
      "palette",
      "errors",
      "Formatted",
      { line: 3, column: 9 },
      50,
    ]);
    store.getState().closeModal();
    expect(store.getState().modal).toBeNull();
  });

  test("run messages for an unknown tabId leave the store unchanged (m-6)", () => {
    const store = createAppStore();
    store.getState().hydrate(payload());
    const before = store.getState();
    store.getState().receiveEvents("r1", [log(1)], "ghost");
    store.getState().receiveState("r1", "transpiling", undefined, "ghost");
    store.getState().receiveDiagnostics("r1", [], "ghost");
    const after = store.getState();
    expect([after.tabs, after.buffers, after.runtimes, after.output, after.diagnostics]).toEqual([
      before.tabs,
      before.buffers,
      before.runtimes,
      before.output,
      before.diagnostics,
    ]);
  });
});
