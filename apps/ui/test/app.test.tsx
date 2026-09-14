import { beforeAll, describe, expect, mock, test } from "bun:test";
import type { BootstrapPayload } from "@jslab/rpc-schema";
import { createTab, defaultSession, defaultSettings } from "@jslab/shared";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentType } from "react";
import type { MainApi } from "../src/api";
import { runStateLabel } from "../src/shell/labels";
import { type AppStore, createAppStore } from "../src/state/store";
import { createFakeApi } from "./fake-api";

// Monaco and the virtualized list need a real browser layout; the shell behavior under test does not.
mock.module("../src/editor/Editor", () => ({ Editor: () => <div data-testid="editor" /> }));
mock.module("../src/output/OutputPanel", () => ({ OutputPanel: () => <div data-testid="output" /> }));

let App: ComponentType<{ store: AppStore; api: MainApi }>;
beforeAll(async () => {
  ({ App } = await import("../src/shell/App"));
});

function renderApp(safeMode: BootstrapPayload["safeMode"] = { active: false, reason: null }) {
  const store = createAppStore();
  store.getState().hydrate({
    settings: defaultSettings(),
    session: defaultSession(() => createTab({ id: "t1" })),
    buffers: { t1: "1 + 1" },
    safeMode,
    versions: { app: "0.0.1", bun: "1.3.13" },
  });
  const { api, emit } = createFakeApi();
  render(<App store={store} api={api} />);
  return { store, api, emit };
}

const press = (code: string, modifiers: { shiftKey?: boolean; altKey?: boolean } = {}) =>
  fireEvent.keyDown(window, { code, metaKey: true, ...modifiers });

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
    fireEvent.click(screen.getByRole("button", { name: "Wait" }));
    fireEvent.click(screen.getByRole("button", { name: "Kill" }));
    expect(api.wait).toHaveBeenCalledWith("t1");
    expect(api.kill).toHaveBeenCalledWith("t1");
  });

  test("safe mode shows a banner and a paused status", () => {
    renderApp({ active: true, reason: "crashLoop" });
    expect(screen.getByTestId("safe-mode-banner").textContent).toContain("didn't shut down cleanly");
    expect(screen.getByTestId("run-status").textContent).toBe("Safe Mode: press ⌘R to run");
  });

  test("edits and language changes are sent to Main for persistence", () => {
    const { store, api } = renderApp();
    act(() => store.getState().editCode("2 + 2"));
    expect(api.bufferChanged).toHaveBeenCalledWith("t1", "2 + 2");
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "javascript" } });
    expect(api.patchTab).toHaveBeenCalledWith("t1", expect.objectContaining({ language: "javascript" }));
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
});

describe("runStateLabel", () => {
  const base = { activeHandles: 0, autoRunArmed: true, safeMode: false };

  test("describes each state", () => {
    expect(runStateLabel({ ...base, state: null, autoRunArmed: false })).toBe("Paused: press ⌘R to run");
    expect(runStateLabel({ ...base, state: "evaluating" })).toBe("Running…");
    expect(runStateLabel({ ...base, state: "settled", activeHandles: 1 })).toBe("Running: 1 active handle");
    expect(runStateLabel({ ...base, state: "settled", activeHandles: 2 })).toBe("Running: 2 active handles");
    expect(runStateLabel({ ...base, state: "killed" })).toBe("Run killed");
    expect(runStateLabel({ ...base, state: "idle" })).toBe("");
  });
});
