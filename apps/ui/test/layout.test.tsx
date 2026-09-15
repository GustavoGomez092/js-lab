import { describe, expect, mock, test } from "bun:test";
import {
  commandMeta,
  createTab,
  defaultSession,
  defaultSettings,
  mergeSettings,
  nextZoom,
  type Settings,
} from "@jslab/shared";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { createViewCommands } from "../src/commands/view-commands";
import { runStateKind } from "../src/shell/labels";
import { SplitPane } from "../src/shell/SplitPane";
import { StatusBar } from "../src/shell/StatusBar";
import { createAppStore } from "../src/state/store";
import { strings } from "../src/strings";
import { createFakeApi } from "./fake-api";

function hydrated() {
  const store = createAppStore();
  store.getState().hydrate({
    settings: defaultSettings(),
    session: defaultSession(() => createTab({ id: "t1" })),
    buffers: { t1: "" },
    safeMode: { active: true, reason: "shift" },
    versions: { app: "0", bun: "1.4.0" },
  });
  return store;
}

describe("settings commands under rapid input (FB-m6)", () => {
  /** An updateSettings whose responses stay pending until released, like a slow settings.json write. */
  function deferredApi(store: ReturnType<typeof hydrated>) {
    const { api } = createFakeApi();
    const pending: { patch: Parameters<typeof mergeSettings>[1]; release(result?: Settings): void }[] = [];
    api.updateSettings.mockImplementation(
      (patch: unknown) =>
        new Promise((resolve) => {
          const typed = patch as Parameters<typeof mergeSettings>[1];
          pending.push({
            patch: typed,
            release: (result) =>
              resolve(result ?? mergeSettings(store.getState().settings ?? defaultSettings(), typed)),
          });
        }),
    );
    return { api, pending };
  }

  test("two quick ⌘= presses give two zoom steps, and a double toggle flips twice", async () => {
    const store = hydrated();
    const { api, pending } = deferredApi(store);
    const commands = new Map(createViewCommands(store, api).map((spec) => [spec.id, spec]));
    const first = commands.get("view.zoomIn")?.run();
    const second = commands.get("view.zoomIn")?.run();
    const one = nextZoom(1, 1);
    const two = nextZoom(one, 1);
    expect(pending.map((request) => request.patch)).toEqual([
      { appearance: { uiScale: one } },
      { appearance: { uiScale: two } },
    ]);
    const secondResult = mergeSettings(defaultSettings(), { appearance: { uiScale: two } });
    pending[0]?.release(mergeSettings(defaultSettings(), { appearance: { uiScale: one } }));
    pending[1]?.release(secondResult);
    await Promise.all([first, second]);
    expect(store.getState().settings?.appearance.uiScale).toBe(two);

    const toggleA = commands.get("view.toggleStatusBar")?.run();
    const toggleB = commands.get("view.toggleStatusBar")?.run();
    expect(pending.slice(2).map((request) => request.patch)).toEqual([
      { view: { statusBar: false } },
      { view: { statusBar: true } },
    ]);
    for (const request of pending.slice(2)) request.release();
    await Promise.all([toggleA, toggleB]);
    expect(store.getState().settings?.view.statusBar).toBe(true);
  });

  test("a late settings.update response doesn't roll back a newer settings.changed broadcast", async () => {
    const store = hydrated();
    const { api, pending } = deferredApi(store);
    const commands = new Map(createViewCommands(store, api).map((spec) => [spec.id, spec]));
    const toggle = commands.get("view.toggleActivityBar")?.run();
    const broadcast = mergeSettings(defaultSettings(), { view: { activityBar: false }, appearance: { fontSize: 20 } });
    store.getState().receiveSettings(broadcast);
    pending[0]?.release(mergeSettings(defaultSettings(), { view: { activityBar: false } }));
    await toggle;
    expect(store.getState().settings).toBe(broadcast);
  });
});

describe("layout", () => {
  test("run states map to status dot kinds", () => {
    expect(
      [null, "transpiling", "evaluating", "settled", "failed", "unresponsive", "idle", "killed"].map((s) =>
        runStateKind(s as Parameters<typeof runStateKind>[0]),
      ),
    ).toEqual(["idle", "running", "running", "settled", "failed", "warn", "idle", "idle"]);
  });

  test("the split resets on double-click and gives the editor everything when output is hidden", () => {
    const onReset = mock(() => {});
    const { rerender } = render(
      <SplitPane
        orientation="horizontal"
        size={70}
        secondVisible
        onResize={() => {}}
        onReset={onReset}
        first={<div>editor</div>}
        second={<div>output</div>}
      />,
    );
    fireEvent.doubleClick(screen.getByRole("separator"));
    expect(onReset).toHaveBeenCalledTimes(1);
    rerender(
      <SplitPane
        orientation="horizontal"
        size={70}
        secondVisible={false}
        onResize={() => {}}
        onReset={onReset}
        first={<div>editor</div>}
        second={<div>output</div>}
      />,
    );
    expect(screen.queryByText("output")).toBeNull();
    expect(screen.queryByRole("separator")).toBeNull();
  });

  test("the status bar shows run state, Safe Mode, runtimes with availability, language, cursor and Vim mode", () => {
    const store = hydrated();
    act(() => {
      store.getState().setCursor({ line: 4, column: 7 });
      store.getState().setVimMode("insert");
    });
    render(<StatusBar store={store} onToggleLayout={() => {}} runKeys="⌘R" />);
    expect(screen.getByTestId("run-status").textContent).toBe("Safe Mode: press ⌘R to run");
    expect(screen.getByText("Safe Mode")).toBeTruthy();
    const runtime = screen.getByLabelText("Runtime") as HTMLSelectElement;
    expect([...runtime.options].map((o) => [o.value, o.disabled])).toEqual([
      ["browser-node", true],
      ["bun", false],
      ["browser", true],
    ]);
    fireEvent.change(screen.getByLabelText("Language"), { target: { value: "jsx" } });
    expect(store.getState().tab?.language).toBe("jsx");
    expect(screen.getByText("Ln 4, Col 7")).toBeTruthy();
    expect(screen.getByText("INSERT")).toBeTruthy();
  });

  test("view commands toggle app-wide settings through Main and per-tab layout locally", async () => {
    const store = hydrated();
    const { api } = createFakeApi();
    api.updateSettings.mockImplementation(async (patch: unknown) =>
      mergeSettings(store.getState().settings ?? defaultSettings(), patch as Parameters<typeof mergeSettings>[1]),
    );
    const commands = new Map(createViewCommands(store, api).map((spec) => [spec.id, spec]));
    await commands.get("view.toggleStatusBar")?.run();
    expect(api.updateSettings).toHaveBeenLastCalledWith({ view: { statusBar: false } });
    expect(store.getState().settings?.view.statusBar).toBe(false);
    expect(commands.get("view.toggleStatusBar")?.description?.()).toBe("currently off");
    await commands.get("view.toggleTabBar")?.run();
    expect(api.updateSettings).toHaveBeenLastCalledWith({ view: { tabBarForSingleTab: false } });
    // Fix round 1 (review m-1): per-tab layout toggles are session state, not app-wide Settings -- they must
    // never round-trip through Main's updateSettings the way the view.* toggles above do.
    const updateSettingsCallsBefore = api.updateSettings.mock.calls.length;
    commands.get("view.toggleOutput")?.run();
    commands.get("view.layoutVertical")?.run();
    expect(store.getState().tab?.layout).toMatchObject({ outputVisible: false, orientation: "vertical" });
    commands.get("view.toggleLayout")?.run();
    expect(store.getState().tab?.layout.orientation).toBe("horizontal");
    // T16-m1: view.layoutHorizontal sets the orientation rather than toggling it.
    commands.get("view.layoutVertical")?.run();
    commands.get("view.layoutHorizontal")?.run();
    commands.get("view.layoutHorizontal")?.run();
    expect(store.getState().tab?.layout.orientation).toBe("horizontal");
    expect(api.updateSettings).toHaveBeenCalledTimes(updateSettingsCallsBefore);
  });

  test("the WD chip shows the folder with its path as a tooltip, opens the picker and clears (TF-19, spec §12.2)", () => {
    const store = createAppStore();
    store.getState().hydrate({
      settings: defaultSettings(),
      session: defaultSession(() => createTab({ id: "t1", workingDirectory: "/work/api" })),
      buffers: { t1: "" },
      safeMode: { active: false, reason: null },
      versions: { app: "0", bun: "1.4.0" },
    });
    const onPick = mock(() => {});
    const onClear = mock(() => {});
    const { rerender } = render(
      <StatusBar
        store={store}
        onToggleLayout={() => {}}
        runKeys="⌘R"
        onPickWorkingDirectory={onPick}
        onClearWorkingDirectory={onClear}
      />,
    );
    const chip = screen.getByRole("button", { name: strings.shell.workingDirectory.change("/work/api") });
    expect([chip.textContent, chip.getAttribute("title")]).toEqual(["api", "/work/api"]);
    fireEvent.click(chip);
    fireEvent.click(screen.getByRole("button", { name: strings.shell.workingDirectory.clear }));
    expect([onPick.mock.calls.length, onClear.mock.calls.length]).toEqual([1, 1]);

    // R24-1: with no working directory, the empty chip explains itself before the click.
    const store2 = hydrated();
    rerender(
      <StatusBar
        store={store2}
        onToggleLayout={() => {}}
        runKeys="⌘R"
        onPickWorkingDirectory={onPick}
        onClearWorkingDirectory={onClear}
      />,
    );
    const emptyChip = screen.getByRole("button", { name: strings.shell.workingDirectory.set });
    expect(emptyChip.getAttribute("title")).toBe(strings.shell.workingDirectory.setHelp);

    // M-3 (fix round 1): the chip labels stay in step with the wd.set/wd.clear command titles (R24-1).
    expect(commandMeta("wd.set")?.title).toBe(strings.shell.workingDirectory.set);
    expect(commandMeta("wd.clear")?.title).toBe(strings.shell.workingDirectory.clear);
  });

  // R24-2: the chip keeps showing "Working directory not found" after the output scrolls away.
  test("the chip shows a missing-directory state after a WorkingDirectoryError (R24-2)", () => {
    const store = createAppStore();
    store.getState().hydrate({
      settings: defaultSettings(),
      session: defaultSession(() => createTab({ id: "t1", workingDirectory: "/work/api" })),
      buffers: { t1: "" },
      safeMode: { active: false, reason: null },
      versions: { app: "0", bun: "1.4.0" },
    });
    store.getState().receiveState("r1", "transpiling");
    store.getState().receiveEvents("r1", [
      {
        kind: "error",
        phase: "runner",
        name: "WorkingDirectoryError",
        message: "Working directory not found: /work/api",
        stack: [],
        seq: 1,
        t: 0,
      },
    ]);
    render(<StatusBar store={store} onToggleLayout={() => {}} runKeys="⌘R" />);
    expect(screen.getByRole("button", { name: strings.shell.workingDirectory.missing("/work/api") })).toBeTruthy();
  });

  // I-1 (fix round 1): picking a new, valid folder must stop the chip from calling it "not found".
  test("picking a new working directory clears the missing-folder warning", () => {
    const store = createAppStore();
    store.getState().hydrate({
      settings: defaultSettings(),
      session: defaultSession(() => createTab({ id: "t1", workingDirectory: "/work/api" })),
      buffers: { t1: "" },
      safeMode: { active: false, reason: null },
      versions: { app: "0", bun: "1.4.0" },
    });
    store.getState().receiveState("r1", "transpiling");
    store.getState().receiveEvents("r1", [
      {
        kind: "error",
        phase: "runner",
        name: "WorkingDirectoryError",
        message: "Working directory not found: /work/api",
        stack: [],
        seq: 1,
        t: 0,
      },
    ]);
    render(<StatusBar store={store} onToggleLayout={() => {}} runKeys="⌘R" />);
    expect(screen.getByRole("button", { name: strings.shell.workingDirectory.missing("/work/api") })).toBeTruthy();

    // The same store action the wd.changed handler uses (App.tsx: applyTabUpdate(tab)).
    act(() => {
      store.getState().applyTabUpdate({
        ...(store.getState().tab as NonNullable<ReturnType<typeof store.getState>["tab"]>),
        workingDirectory: "/work/api2",
      });
    });

    expect(screen.queryByRole("button", { name: strings.shell.workingDirectory.missing("/work/api2") })).toBeNull();
    const chip = screen.getByRole("button", { name: strings.shell.workingDirectory.change("/work/api2") });
    expect(chip.getAttribute("aria-label")).not.toContain("not found");
    expect(chip.className).not.toContain("status-wd-missing");
    expect(store.getState().output.stale).toBe(true);
  });
});
