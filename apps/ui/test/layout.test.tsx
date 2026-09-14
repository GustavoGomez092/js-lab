import { describe, expect, mock, test } from "bun:test";
import { createTab, defaultSession, defaultSettings, mergeSettings } from "@jslab/shared";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { createViewCommands } from "../src/commands/view-commands";
import { runStateKind } from "../src/shell/labels";
import { SplitPane } from "../src/shell/SplitPane";
import { StatusBar } from "../src/shell/StatusBar";
import { createAppStore } from "../src/state/store";
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
    render(<StatusBar store={store} onToggleLayout={() => {}} />);
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
});
