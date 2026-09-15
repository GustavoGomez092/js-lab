import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { type BootstrapPayload, MAX_TEXT_CHARS, type TabCloseResult } from "@jslab/rpc-schema";
import {
  parseChord as chordOf,
  createTab,
  DEFAULT_KEYBINDINGS,
  defaultSession,
  defaultSettings,
  formatChord,
  type KeybindingRule,
  MAX_CLOSED_TABS,
  mergeSettings,
  resolveKeybindings,
  type Settings,
  shortcutFor,
} from "@jslab/shared";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { type ComponentType, Profiler } from "react";
import type { MainApi } from "../src/api";
import { type EditorHandle, type OffsetEdit, setEditorHandle } from "../src/editor/editor-handle";
import { createVimStatusNode } from "../src/editor/vim-status";
import type { FormatOutcome } from "../src/format/format-core";
import type { Formatter } from "../src/format/formatter";
import { applyEdits } from "../src/format/line-diff";
import * as OutputPanelModule from "../src/output/OutputPanel";
import { ActivityBar } from "../src/shell/ActivityBar";
import { runStateLabel } from "../src/shell/labels";
import { BUFFER_SYNC_DELAY_MS } from "../src/state/buffer-sync";
import { type AppStore, createAppStore } from "../src/state/store";
import { strings } from "../src/strings";
import { createFakeApi } from "../test/fake-api";

// T19A-mock: this file runs in its own `bun test` process (package.json "test"), so these module mocks can't leak into
// any other test file. Monaco and the virtualized list need a real browser layout; the shell behavior under test
// does not.
const RealOutputPanel = OutputPanelModule.OutputPanel;
mock.module("../src/editor/Editor", () => ({ Editor: () => <div data-testid="editor" /> }));
mock.module("../src/output/OutputPanel", () => ({ OutputPanel: () => <div data-testid="output" /> }));
afterAll(() => {
  mock.module("../src/output/OutputPanel", () => ({ OutputPanel: RealOutputPanel }));
});

let App: ComponentType<{
  store: AppStore;
  api: MainApi;
  scheduleFrame?: (callback: () => void) => void;
  formatter?: Formatter;
}>;
beforeAll(async () => {
  ({ App } = await import("../src/shell/App"));
});

function renderApp(
  safeMode: BootstrapPayload["safeMode"] = { active: false, reason: null },
  keybindings: KeybindingRule[] = [],
  scheduleFrame: (callback: () => void) => void = (callback) => callback(),
  options: { formatter?: Formatter; settings?: Settings } = {},
) {
  const store = createAppStore();
  store.getState().hydrate({
    settings: options.settings ?? defaultSettings(),
    session: defaultSession(() => createTab({ id: "t1" })),
    buffers: { t1: "1 + 1" },
    safeMode,
    keybindings,
    versions: { app: "0.0.1", bun: "1.3.13" },
  });
  const { api, emit } = createFakeApi();
  render(<App store={store} api={api} scheduleFrame={scheduleFrame} formatter={options.formatter} />);
  return { store, api, emit };
}

const press = (code: string, modifiers: { shiftKey?: boolean; altKey?: boolean } = {}) =>
  fireEvent.keyDown(window, { code, metaKey: true, ...modifiers });

/** A Formatter whose `format` calls stay pending until `release` is called with the outcome. */
function gatedFormatter() {
  let releaseNext: ((outcome: FormatOutcome) => void) | null = null;
  const formatter: Formatter = {
    format: () =>
      new Promise((resolve) => {
        releaseNext = resolve;
      }),
    dispose: () => {},
  };
  return { formatter, release: (outcome: FormatOutcome) => releaseNext?.(outcome) };
}

/**
 * A minimal EditorHandle backed by the store's buffer for `tabId`, whose `applyOffsetEdits` mirrors
 * Monaco's real content-change listener: it writes back through `editCode` synchronously (fix round 1,
 * I-1/I-2/m-4 setups).
 */
function fakeEditor(store: AppStore, tabId: string, focused = true) {
  const applyOffsetEdits = mock((edits: OffsetEdit[]) => {
    const next = applyEdits(store.getState().buffers[tabId] ?? "", edits);
    store.getState().editCode(next, tabId);
  });
  const handle = {
    getValue: () => store.getState().buffers[tabId] ?? "",
    getCursorOffset: () => 0,
    hasFocus: () => focused,
    applyOffsetEdits,
  } as unknown as EditorHandle;
  return { handle, applyOffsetEdits };
}

describe("App shell", () => {
  test("Cmd+R starts a manual run with the current code", () => {
    const { api } = renderApp();
    press("KeyR");
    expect(api.startRun).toHaveBeenCalledWith({
      tabId: "t1",
      code: "1 + 1",
      language: "typescript",
      logpoints: [],
      reason: "manual",
    });
  });

  // R-M2-T21-2: Main would reject a run.start whose code exceeds MAX_TEXT_CHARS; the UI must say so instead
  // of failing silently or sending the oversized payload.
  test("Cmd+R on a tab larger than MAX_TEXT_CHARS reports the limit instead of starting a run", () => {
    const { store, api } = renderApp();
    act(() => store.getState().editCode("a".repeat(MAX_TEXT_CHARS + 1)));
    // m-3 (fix round 1): editCode above already sets this message through the buffer subscription
    // (App.tsx's MAX_TEXT_CHARS guard on buffer changes), so clear it first -- otherwise the assertion
    // below can't tell whether the run guard itself ran.
    act(() => store.getState().setStatusMessage(null));
    press("KeyR");
    expect(api.startRun).not.toHaveBeenCalled();
    expect(store.getState().statusMessage).toBe(strings.limits.tooLarge);
  });

  // I-1 (fix round 1): with Auto Run and Format on Run both on, a format that edits the code arms a
  // pending auto-run for the identical, already-formatted code. That pending run must not survive past
  // the manual run it duplicates.
  test("format on run does not double-run when Auto Run is also on (I-1)", async () => {
    const settings = mergeSettings(defaultSettings(), {
      run: { autoRun: true, formatOnRun: true, autoRunDelayMs: 50 },
    });
    const { formatter, release } = gatedFormatter();
    const { store, api } = renderApp(undefined, [], (callback) => callback(), { formatter, settings });
    const { handle } = fakeEditor(store, "t1");
    setEditorHandle(handle);
    try {
      press("KeyR");
      await act(async () => {
        release({ ok: true, formatted: "2;\n", cursorOffset: 0 });
        await Bun.sleep(1);
      });
      expect(api.startRun.mock.calls).toHaveLength(1);
      expect(api.startRun.mock.calls[0]?.[0]).toMatchObject({ tabId: "t1", code: "2;\n", reason: "manual" });
      // Long enough for the auto-run timer the format's own edit armed to have fired, if it wasn't cancelled.
      await act(async () => {
        await Bun.sleep(150);
      });
      expect(api.startRun.mock.calls).toHaveLength(1);
    } finally {
      setEditorHandle(null);
    }
  });

  // I-2 (fix round 1): a tab switch while Format on Run's format is in flight must not run the newly
  // active tab; the run started must still be the tab that was active at Cmd+R, with its own code.
  test("switching tabs during format on run still runs the tab that was active at Cmd+R (I-2)", async () => {
    const settings = mergeSettings(defaultSettings(), { run: { autoRun: false, formatOnRun: true } });
    const { formatter, release } = gatedFormatter();
    const { store, api } = renderApp(undefined, [], (callback) => callback(), { formatter, settings });
    const { handle } = fakeEditor(store, "t1");
    setEditorHandle(handle);
    try {
      press("KeyR");
      act(() => store.getState().openTab(createTab({ id: "t2" }), "other()", true));
      await act(async () => {
        release({ ok: true, formatted: "2;\n", cursorOffset: 0 });
        await Bun.sleep(1);
      });
      expect(api.startRun.mock.calls).toHaveLength(1);
      expect(api.startRun.mock.calls[0]?.[0]).toMatchObject({ tabId: "t1", code: "1 + 1", reason: "manual" });
    } finally {
      setEditorHandle(null);
    }
  });

  // m-4 (fix round 1): dedicated App-level coverage for the Format on Run wiring itself (format.document's
  // isEnabled, the flows beforeSave spread and wantsFormat/lastTypedAt were previously only exercised by
  // E2E). Shares I-1/I-2's fake editor and gated-formatter shapes.
  test("format on run skips while typing and formats once the 1 second window has passed (m-4)", async () => {
    const settings = mergeSettings(defaultSettings(), { run: { autoRun: false, formatOnRun: true } });
    const formatSpy = mock(async (code: string) => ({ ok: true as const, formatted: `${code};`, cursorOffset: 0 }));
    const formatter: Formatter = { format: (code) => formatSpy(code), dispose: () => {} };
    const { store, api } = renderApp(undefined, [], (callback) => callback(), { formatter, settings });
    const { handle } = fakeEditor(store, "t1");
    setEditorHandle(handle);
    try {
      // An edit immediately followed by Cmd+R: still typing (within 1s), so the format is skipped.
      act(() => store.getState().editCode("1+1", "t1"));
      press("KeyR");
      expect(formatSpy).not.toHaveBeenCalled();
      expect(api.startRun.mock.calls).toHaveLength(1);

      // Past the 1s window, the same edit is stale, so Cmd+R formats before running.
      await act(async () => {
        await Bun.sleep(1050);
      });
      press("KeyR");
      await act(async () => {
        await Bun.sleep(1);
      });
      expect(formatSpy).toHaveBeenCalledTimes(1);
      expect(api.startRun.mock.calls).toHaveLength(2);
    } finally {
      setEditorHandle(null);
    }
  });

  // FB-m5: a run clears a transient status message, before any format-on-run can report its own.
  test("a manual run clears a transient status message but not a sticky one (FB-m5)", () => {
    const { store } = renderApp();
    act(() => store.getState().setStatusMessage("Saved a.ts"));
    press("KeyR");
    expect(store.getState().statusMessage).toBeNull();
    act(() => store.getState().setStatusMessage("Formatting…", { sticky: true }));
    press("KeyR");
    expect(store.getState().statusMessage).toBe("Formatting…");
  });

  test("Cmd+Shift+R stops and Cmd+Alt+R kills", () => {
    const { api } = renderApp();
    press("KeyR", { shiftKey: true });
    press("KeyR", { altKey: true });
    expect(api.stop).toHaveBeenCalledWith("t1");
    expect(api.kill).toHaveBeenCalledWith("t1");
  });

  test("menu commands trigger the same actions", async () => {
    const { api, emit } = renderApp();
    await emit("menu.command", { command: "run.start" });
    expect(api.startRun).toHaveBeenCalledTimes(1);
  });

  test("the unresponsive dialog forwards Wait and Kill", async () => {
    const { api, emit } = renderApp();
    await emit("run.state", { tabId: "t1", runId: "r1", state: "transpiling" });
    await emit("run.state", { tabId: "t1", runId: "r1", state: "unresponsive" });
    fireEvent.click(screen.getByRole("button", { name: strings.shell.unresponsive.wait }));
    fireEvent.click(screen.getByRole("button", { name: strings.shell.unresponsive.kill }));
    expect(api.wait).toHaveBeenCalledWith("t1");
    expect(api.kill).toHaveBeenCalledWith("t1");
  });

  test("safe mode shows a banner and a paused status", () => {
    renderApp({ active: true, reason: "crashLoop" });
    expect(screen.getByTestId("safe-mode-banner").textContent).toBe(strings.shell.safeModeBanner.crashLoop);
    expect(screen.getByTestId("run-status").textContent).toBe(strings.shell.runState.safeModePaused("⌘R"));
  });

  test("edits are sent to Main once per coalescing delay, and language changes at once (X5)", async () => {
    const { store, api } = renderApp();
    act(() => store.getState().editCode("2"));
    act(() => store.getState().editCode("2 + 2"));
    expect(api.bufferChanged).not.toHaveBeenCalled();
    // Waits for the coalescing timer without a fixed sleep; one call proves the two edits were coalesced.
    await waitFor(() => expect(api.bufferChanged).toHaveBeenCalledTimes(1), { timeout: BUFFER_SYNC_DELAY_MS + 2000 });
    expect(api.bufferChanged.mock.calls).toEqual([["t1", "2 + 2"]]);
    fireEvent.change(screen.getByLabelText("Language"), { target: { value: "javascript" } });
    expect(api.patchTab).toHaveBeenCalledWith("t1", expect.objectContaining({ language: "javascript" }));
  });

  test("app.flushState flushes pending edits and view state, then acknowledges (X1)", async () => {
    const { store, api, emit } = renderApp();
    const order: string[] = [];
    const flushViewState = mock(() => void order.push("viewState"));
    setEditorHandle({ flushViewState } as unknown as EditorHandle);
    api.bufferChanged.mockImplementation(() => void order.push("buffer"));
    api.stateFlushed.mockImplementation(() => void order.push("ack"));
    act(() => store.getState().editCode("3 + 3"));
    await emit("app.flushState", {});
    expect(order).toEqual(["viewState", "buffer", "ack"]);
    setEditorHandle(null);
  });

  // M-2 (R-M3-T19-FIX-1): WebKit fires pagehide more reliably than beforeunload when the view goes away.
  test("a pending edit is sent when the page hides", () => {
    const { store, api } = renderApp();
    act(() => store.getState().editCode("4 + 4"));
    expect(api.bufferChanged).not.toHaveBeenCalled();
    window.dispatchEvent(new Event("pagehide"));
    expect(api.bufferChanged.mock.calls).toEqual([["t1", "4 + 4"]]);
  });

  test("Help menu commands are forwarded to Main", async () => {
    const { api, emit } = renderApp();
    await emit("menu.command", { command: "help.copyDebugLog" });
    await emit("menu.command", { command: "help.restartSafeMode" });
    expect(api.appCommand.mock.calls).toEqual([["copyDebugLog"], ["restartSafeMode"]]);
  });

  test("startup notices from Main show until dismissed (spec §20)", () => {
    const { store } = renderApp();
    act(() =>
      store.setState({
        notices: [
          {
            id: "settingsRecovered",
            message: "Settings were reset because the file was unreadable. A copy was saved as settings.corrupt-1.json",
          },
        ],
      }),
    );
    expect(screen.getByTestId("startup-notices").textContent).toContain("settings.corrupt-1.json");
    fireEvent.click(screen.getByRole("button", { name: /^Dismiss:/ }));
    expect(screen.queryByTestId("startup-notices")).toBeNull();
  });

  test("an app.notice from Main after startup is shown once until dismissed, and an invalid one is ignored (FA-I3)", async () => {
    const { emit } = renderApp();
    await emit("app.notice", { id: "unexpectedError", message: "Something went wrong." });
    await emit("app.notice", { id: "unexpectedError", message: "Something went wrong." });
    await emit("app.notice", { id: "notAKnownNotice", message: "ignored" } as never);
    expect(screen.getByTestId("startup-notices").textContent).toContain("Something went wrong.");
    expect(screen.getAllByRole("button", { name: /^Dismiss:/ })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: /^Dismiss:/ }));
    expect(screen.queryByTestId("startup-notices")).toBeNull();
  });

  // Spec §20 (R-M2-FINAL-5): the unexpected-error notice offers Copy Debug Log right in the banner.
  test("the unexpected-error notice's Copy Debug Log button sends the app command (§20)", async () => {
    const { api, emit } = renderApp();
    await emit("app.notice", { id: "unexpectedError", message: "Something went wrong." });
    fireEvent.click(screen.getByRole("button", { name: strings.notices.copyDebugLog }));
    expect(api.appCommand.mock.calls).toEqual([["copyDebugLog"]]);
    await emit("app.notice", { id: "settingsNewer", message: "Settings were written by a newer JSLab." });
    expect(screen.getAllByRole("button", { name: strings.notices.copyDebugLog })).toHaveLength(1);
  });

  test("tab commands create, switch and close tabs through Main", async () => {
    const { store, api, emit } = renderApp();
    api.createTab.mockImplementation(async () => ({ tab: createTab({ id: "t2" }) }));
    api.closeTab.mockImplementation(async () => ({ ok: true, activeTabId: "t2", replacement: null }));
    await emit("menu.command", { command: "tab.new" });
    expect([store.getState().tabOrder, store.getState().activeTabId]).toEqual([["t1", "t2"], "t2"]);
    await emit("menu.command", { command: "tab.previous" });
    expect(store.getState().activeTabId).toBe("t1");
    expect(api.activateTab).toHaveBeenCalledWith("t1");
    await emit("menu.command", { command: "tab.close" });
    expect(api.closeTab).toHaveBeenCalledWith("t1");
    expect([store.getState().tabOrder, store.getState().activeTabId]).toEqual([["t2"], "t2"]);
  });

  test("run messages for a background tab update only that tab", async () => {
    const { store, emit } = renderApp();
    act(() => store.getState().openTab(createTab({ id: "t2" }), "", false));
    await emit("run.state", { tabId: "t2", runId: "r9", state: "transpiling" });
    await emit("run.events", {
      tabId: "t2",
      runId: "r9",
      events: [{ kind: "stdout", text: "bg\n", seq: 1, t: 0 }],
    });
    expect(store.getState().runtimes.t2?.output.entries).toHaveLength(1);
    expect(store.getState().output.entries).toHaveLength(0);
  });

  test("a run.state message first applies the events still queued for its tab, and the frame applies nothing twice (M12)", async () => {
    const frames: (() => void)[] = [];
    const { store, emit } = renderApp(undefined, [], (callback) => {
      frames.push(callback);
    });
    await emit("run.state", { tabId: "t1", runId: "r1", state: "transpiling" });
    await emit("run.events", {
      tabId: "t1",
      runId: "r1",
      events: [{ kind: "stdout", text: "queued\n", seq: 1, t: 0 }],
    });
    expect([frames.length, store.getState().output.entries.length]).toEqual([1, 0]);
    await emit("run.state", { tabId: "t1", runId: "r1", state: "idle" });
    expect([store.getState().output.entries.length, store.getState().output.runState]).toEqual([1, "idle"]);
    act(() => {
      for (const frame of frames.splice(0)) frame();
    });
    expect(store.getState().output.entries.map((entry) => entry.event)).toEqual([
      { kind: "stdout", text: "queued\n", seq: 1, t: 0 },
    ]);
  });

  test("a duplicate close result for an already-removed tab is ignored (I-1)", async () => {
    const { store, api, emit } = renderApp();
    const resolvers: Array<(result: TabCloseResult) => void> = [];
    api.closeTab.mockImplementation(() => new Promise((resolve) => resolvers.push(resolve)));
    await emit("menu.command", { command: "tab.close" });
    await emit("menu.command", { command: "tab.close" });
    expect(resolvers).toHaveLength(2);
    await act(async () => {
      resolvers[0]?.({ ok: true, activeTabId: "", replacement: null });
      await Bun.sleep(1);
    });
    expect(store.getState().closedCount).toBe(1);
    await act(async () => {
      resolvers[1]?.({ ok: true, activeTabId: "", replacement: null });
      await Bun.sleep(1);
    });
    expect(store.getState().closedCount).toBe(1);
  });

  test("closedCount never exceeds MAX_CLOSED_TABS on increment (I-1)", async () => {
    const { store, api, emit } = renderApp();
    act(() => store.setState({ closedCount: MAX_CLOSED_TABS }));
    api.closeTab.mockImplementation(async () => ({ ok: true, activeTabId: "", replacement: null }));
    await emit("menu.command", { command: "tab.close" });
    expect(store.getState().closedCount).toBe(MAX_CLOSED_TABS);
  });

  test("a close result no longer overrides a tab switch made while the close was in flight (I-2)", async () => {
    const { store, api, emit } = renderApp();
    act(() => {
      store.getState().openTab(createTab({ id: "t2" }), "", false);
      store.getState().openTab(createTab({ id: "t3" }), "", false);
    });
    let resolveClose: (result: TabCloseResult) => void = () => {};
    api.closeTab.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveClose = resolve;
        }),
    );
    await emit("menu.command", { command: "tab.close" }); // closes t1, the active tab at command time
    act(() => store.getState().activateTab("t3"));
    await act(async () => {
      resolveClose({ ok: true, activeTabId: "t2", replacement: null });
      await Bun.sleep(1);
    });
    expect(store.getState().activeTabId).toBe("t3");
    expect(store.getState().tabs.t1).toBeUndefined();
  });

  test("closing the last tab adopts Main's replacement (m-6)", async () => {
    const { store, api, emit } = renderApp();
    api.closeTab.mockImplementation(async () => ({
      ok: true,
      activeTabId: "unused",
      replacement: { tab: createTab({ id: "t2" }), content: "replacement code" },
    }));
    await emit("menu.command", { command: "tab.close" });
    expect(store.getState().tabOrder).toEqual(["t2"]);
    expect(store.getState().activeTabId).toBe("t2");
    expect(store.getState().code).toBe("replacement code");
  });

  test("Cmd+2 activates the second tab; Cmd+Shift+T reopens only when a closed tab exists", () => {
    const { store, api } = renderApp();
    act(() => store.getState().openTab(createTab({ id: "t2" }), "", false));
    press("Digit2");
    expect(store.getState().activeTabId).toBe("t2");
    expect(api.activateTab).toHaveBeenCalledWith("t2");
    press("KeyT", { shiftKey: true });
    expect(api.reopenTab).not.toHaveBeenCalled();
    act(() => store.getState().setClosedCount(1));
    press("KeyT", { shiftKey: true });
    expect(api.reopenTab).toHaveBeenCalledTimes(1);
  });

  test("keybinding overrides from keybindings.json replace defaults", async () => {
    const { store, emit } = renderApp(undefined, [
      { key: "cmd+k", command: "-output.clear" },
      { key: "cmd+shift+k", command: "output.clear" },
    ]);
    await emit("run.state", { tabId: "t1", runId: "r1", state: "transpiling" });
    await emit("run.events", { tabId: "t1", runId: "r1", events: [{ kind: "stdout", text: "x\n", seq: 1, t: 0 }] });
    press("KeyK");
    expect(store.getState().output.entries).toHaveLength(1);
    press("KeyK", { shiftKey: true });
    expect(store.getState().output.entries).toHaveLength(0);
  });

  // I-1 (fix round 1): the persistence subscriber must compare layout fields, not the layout object
  // reference, which `updateLayout` always replaces (state/store.ts) -- otherwise every clamped
  // setEditorSize (even one that doesn't change the clamped value) sends a redundant patchTab.
  test("setting the same clamped editor size twice patches the tab only once", () => {
    const { store, api } = renderApp();
    act(() => store.getState().setEditorSize(95));
    act(() => store.getState().setEditorSize(95));
    expect(api.patchTab).toHaveBeenCalledTimes(1);
  });

  test("view settings hide the activity bar and status bar, and hidden output leaves only the editor", async () => {
    const { store, emit } = renderApp();
    expect(document.querySelector(".activity-bar")).not.toBeNull();
    // R-M2-USER-1: the toolbar row is the window drag region; its action buttons opt back out, or every
    // click on Run/Auto Run would instead start dragging the (hiddenInset) window.
    expect(document.querySelector(".toolbar")?.classList.contains("electrobun-webkit-app-region-drag")).toBe(true);
    expect(document.querySelector(".toolbar-actions")?.classList.contains("electrobun-webkit-app-region-no-drag")).toBe(
      true,
    );
    // Task 17: the tab bar lives in the toolbar's drag region as the requested `.toolbar-tabs` slot
    // (Task 16), and opts itself out of dragging, or every click, middle-click and drag-reorder on a
    // tab would instead drag the window.
    expect(document.querySelector(".toolbar-tabs .tab-bar")).not.toBeNull();
    expect(document.querySelector(".tab-bar")?.classList.contains("electrobun-webkit-app-region-no-drag")).toBe(true);
    await emit("settings.changed", {
      settings: mergeSettings(store.getState().settings ?? defaultSettings(), {
        view: { activityBar: false, statusBar: false },
      }),
    });
    expect(document.querySelector(".activity-bar")).toBeNull();
    expect(document.querySelector(".status-bar")).toBeNull();
    act(() => store.getState().toggleOutputVisible());
    expect(screen.queryByTestId("output")).toBeNull();
    expect(screen.getByTestId("editor")).toBeTruthy();
  });

  test("the tab bar hides for a single tab when Tab Bar is off, and returns with a second tab", async () => {
    const { store, emit } = renderApp();
    expect(document.querySelector(".tab-bar")).not.toBeNull();
    await emit("settings.changed", {
      settings: mergeSettings(store.getState().settings ?? defaultSettings(), { view: { tabBarForSingleTab: false } }),
    });
    expect(document.querySelector(".tab-bar")).toBeNull();
    act(() => store.getState().openTab(createTab({ id: "t2" }), "", false));
    expect(document.querySelector(".tab-bar")).not.toBeNull();
  });

  // Fix round 1 (I-2). ⌘⇧P toggles the palette both open and closed. The resolver skips view.commandPalette
  // entirely while a modal is open (keybindings/resolver.ts), so the second ⌘⇧P must be dispatched at the
  // focused combobox itself (as a real keypress would arrive), not at window.
  test("⌘⇧P opens the palette with output context, and ⌘⇧P from inside it closes", () => {
    const { store } = renderApp();
    store.getState().setFocus("output");
    press("KeyP", { shiftKey: true });
    expect(store.getState().modal).toEqual({ kind: "palette", context: "output" });
    // Runtime/Language <select>s in the status bar are also role "combobox"; name the palette's own input.
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Command palette" }), {
      code: "KeyP",
      metaKey: true,
      shiftKey: true,
    });
    expect(store.getState().modal).toBeNull();
  });

  // Fix round 1 (m-5). store.focus is only set by explicit focus-capture handlers and is never reset when
  // focus moves elsewhere, so it can go stale. The palette context must follow the real DOM focus (a toolbar
  // button here, not inside ".output") rather than trusting the stale "output" left in store.focus.
  test("palette context follows real DOM focus rather than a stale store.focus", () => {
    const { store } = renderApp();
    store.getState().setFocus("output");
    screen.getByRole("button", { name: /Auto Run/ }).focus();
    press("KeyP", { shiftKey: true });
    expect(store.getState().modal).toEqual({ kind: "palette", context: "editor" });
  });

  // FB-m9: with the tab bar hidden for one tab, the toolbar title follows edits.
  test("the single-tab toolbar title updates as the code is edited (FB-m9)", () => {
    const settings = mergeSettings(defaultSettings(), { view: { tabBarForSingleTab: false } });
    const { store } = renderApp(undefined, [], undefined, { settings });
    expect(document.querySelector(".toolbar-title")?.textContent).toBe("1 + 1");
    act(() => store.getState().editCode("\n  const renamed = 2\n", "t1"));
    expect(document.querySelector(".toolbar-title")?.textContent).toBe("const renamed = 2");
  });

  // FB-I2: a view-state commit (cursor or scroll, every ~500 ms) replaces the tab object. The shell selects
  // primitives, so it doesn't re-render for that.
  test("a view-state commit doesn't re-render the shell (FB-I2)", () => {
    const store = createAppStore();
    store.getState().hydrate({
      settings: mergeSettings(defaultSettings(), { view: { tabBarForSingleTab: false } }),
      session: defaultSession(() => createTab({ id: "t1" })),
      buffers: { t1: "1 + 1" },
      safeMode: { active: false, reason: null },
      versions: { app: "0.0.1", bun: "1.3.13" },
    });
    const { api } = createFakeApi();
    let commits = 0;
    render(
      <Profiler id="shell" onRender={() => commits++}>
        <App store={store} api={api} scheduleFrame={(callback) => callback()} />
      </Profiler>,
    );
    commits = 0;
    act(() => store.getState().setViewState("t1", { cursor: 3 }));
    expect(commits).toBe(0);
  });

  // FB-m3: the toolbar and activity bar keycaps follow keybindings.json, as the palette and menu do.
  test("a rebound Run chord shows in the toolbar keycap and the activity bar title (FB-m3)", async () => {
    const rules = [{ key: "cmd+enter", command: "run.start" }];
    const run = formatChord(shortcutFor(resolveKeybindings(DEFAULT_KEYBINDINGS, rules), "run.start") ?? chordOf("x"));
    expect(run).not.toBe("⌘R");
    const { emit } = renderApp(undefined, rules);
    expect(document.querySelector(".toolbar .tb-btn.run .kbd")?.textContent).toBe(run);
    expect(screen.getByRole("button", { name: strings.shell.run, hidden: false }).getAttribute("title")).toBe(
      `${strings.shell.run} (${run})`,
    );
    expect(screen.getByRole("button", { name: strings.shell.settings }).getAttribute("title")).toBe(
      `${strings.shell.settings} (⌘,)`,
    );
    // A new run id is accepted only in `transpiling` (state/output.ts); that state is busy, so Stop shows.
    await emit("run.state", { tabId: "t1", runId: "r1", state: "transpiling" });
    expect(document.querySelector(".toolbar .tb-btn.run .kbd")?.textContent).toBe("⇧⌘R");
  });

  // Status-bar residual item: the "press ⌘R" label derives its chord from the effective bindings too.
  test("a rebound Run chord shows in the status-bar paused label", () => {
    const rules = [{ key: "cmd+enter", command: "run.start" }];
    const run = formatChord(shortcutFor(resolveKeybindings(DEFAULT_KEYBINDINGS, rules), "run.start") ?? chordOf("x"));
    expect(run).not.toBe("⌘R");
    renderApp(undefined, rules);
    expect(screen.getByTestId("run-status").textContent).toBe(strings.shell.runState.paused(run));
  });

  test("with the Run binding removed, the status-bar paused label omits a keycap", () => {
    const rules = [{ key: "cmd+r", command: "-run.start" }];
    renderApp(undefined, rules);
    expect(screen.getByTestId("run-status").textContent).toBe(strings.shell.runState.paused(null));
  });

  // T16-rr1: the Vim status node lives in a React-owned slot before the status bar, so turning the status bar off
  // and on again can't move the Vim prompt below it.
  test("the Vim status slot stays directly before the status bar when the status bar remounts (T16-rr1)", async () => {
    const { store, emit } = renderApp();
    const slot = document.querySelector(".app > .vim-slot");
    if (!slot) throw new Error("expected a .vim-slot in .app");
    expect(slot.nextElementSibling?.classList.contains("status-bar")).toBe(true);
    const node = createVimStatusNode(slot);
    const settings = (patch: Parameters<typeof mergeSettings>[1]) => ({
      settings: mergeSettings(store.getState().settings ?? defaultSettings(), patch),
    });
    await emit("settings.changed", settings({ view: { statusBar: false } }));
    expect(document.querySelector(".status-bar")).toBeNull();
    await emit("settings.changed", settings({ view: { statusBar: true } }));
    expect(document.querySelector(".app > .vim-slot")).toBe(slot);
    expect(node.parentElement).toBe(slot as HTMLElement);
    expect(slot.nextElementSibling?.classList.contains("status-bar")).toBe(true);
  });

  // T16-m1-part: togglePanel opens the side bar on a panel, switches panels while open, and closes on the open one.
  test("activity bar panels open, switch and close the side bar, and NPM stays disabled (T16-m1-part)", async () => {
    const { store, api } = renderApp();
    api.updateSettings.mockImplementation(async (patch: unknown) =>
      mergeSettings(store.getState().settings ?? defaultSettings(), patch as Parameters<typeof mergeSettings>[1]),
    );
    const click = (name: string) =>
      act(async () => {
        fireEvent.click(screen.getByRole("button", { name }));
        await Bun.sleep(1);
      });
    const state = () => [
      document.querySelector(".side-bar") !== null,
      store.getState().sideBarPanel,
      api.updateSettings.mock.calls.length,
    ];
    expect(state()).toEqual([false, "snippets", 0]);
    await click(strings.shell.aiChat);
    expect(state()).toEqual([true, "ai", 1]);
    expect(screen.getByRole("button", { name: strings.shell.aiChat }).getAttribute("aria-pressed")).toBe("true");
    await click(strings.shell.snippets);
    expect(state()).toEqual([true, "snippets", 1]);
    await click(strings.shell.snippets);
    expect(state()).toEqual([false, "snippets", 2]);
    const npm = screen.getByRole("button", { name: strings.shell.npm }) as HTMLButtonElement;
    expect([npm.disabled, npm.getAttribute("aria-pressed")]).toEqual([false, "false"]);
    expect((screen.getByRole("button", { name: strings.shell.settings }) as HTMLButtonElement).disabled).toBe(false);
  });

  test("the activity bar disables Settings, with a later-version tooltip, when it can't open (T16-m1-part)", () => {
    render(
      <ActivityBar
        busy={false}
        sideBarOpen={false}
        panel="snippets"
        canOpenSettings={false}
        runKeys="⌘R"
        stopKeys="⇧⌘R"
        settingsKeys="⌘,"
        onRun={() => {}}
        onStop={() => {}}
        onPanel={() => {}}
        onSettings={() => {}}
      />,
    );
    const settings = screen.getByRole("button", { name: strings.shell.settings }) as HTMLButtonElement;
    expect([settings.disabled, settings.title]).toEqual([true, strings.shell.laterMilestone]);
  });

  test("⌘, asks Main to open the Settings window", () => {
    const { api } = renderApp();
    press("Comma");
    expect(api.appCommand).toHaveBeenCalledWith("openSettings");
  });
});

describe("runStateLabel", () => {
  const base = { activeHandles: 0, autoRunArmed: true, safeMode: false, keys: "⌘R" };

  test("describes each state", () => {
    const labels = strings.shell.runState;
    expect(runStateLabel({ ...base, state: null, autoRunArmed: false })).toBe(labels.paused("⌘R"));
    expect(runStateLabel({ ...base, state: "evaluating" })).toBe(labels.running);
    expect(labels.settled(1)).toBe("Running: 1 active handle");
    expect(runStateLabel({ ...base, state: "settled", activeHandles: 1 })).toBe(labels.settled(1));
    expect(runStateLabel({ ...base, state: "settled", activeHandles: 2 })).toBe("Running: 2 active handles");
    expect(runStateLabel({ ...base, state: "killed" })).toBe(labels.killed);
    expect(runStateLabel({ ...base, state: "idle" })).toBe("");
  });

  // Status-bar residual item: a null chord (the binding was removed) renders without a keycap.
  test("a paused state with no Run binding omits the keycap", () => {
    expect(runStateLabel({ ...base, state: null, autoRunArmed: false, keys: null })).toBe(
      strings.shell.runState.paused(null),
    );
  });

  test("a safe-mode paused state with no Run binding omits the keycap", () => {
    expect(runStateLabel({ ...base, state: null, safeMode: true, keys: null })).toBe(
      strings.shell.runState.safeModePaused(null),
    );
  });
});
