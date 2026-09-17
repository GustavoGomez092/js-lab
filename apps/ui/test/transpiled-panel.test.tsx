import { describe, expect, test } from "bun:test";
import { createTab, defaultSession, defaultSettings } from "@jslab/shared";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { TranspiledPanel } from "../src/output/TranspiledPanel";
import { SideBar } from "../src/shell/SideBar";
import type { AppState } from "../src/state/store";
import { createAppStore } from "../src/state/store";
import { strings } from "../src/strings";
import { createFakeApi } from "./fake-api";

/** The buffer the fake tab holds, and the source Main reports as the one it transpiled -- equal, so not stale. */
const SOURCE = "const a = 5";

function setup() {
  const store = createAppStore();
  store.getState().hydrate({
    settings: defaultSettings(),
    session: defaultSession(() => createTab({ id: "t1" })),
    buffers: { t1: SOURCE },
    safeMode: { active: false, reason: null },
    versions: { app: "0", bun: "1.4.0" },
  });
  const { api } = createFakeApi();
  api.transpiled.mockImplementation(async (_tabId: string, hideInstrumentation: boolean) => ({
    code: hideInstrumentation ? "const a = 5;" : "__jl.log(1, const a = 5);",
    source: SOURCE,
  }));
  return { store, api };
}

describe("transpiled output panel (spec §7.4)", () => {
  test("shows the latest Babel output and refreshes when a new run starts", async () => {
    const { store, api } = setup();
    await act(async () => {
      render(<TranspiledPanel store={store} api={api} />);
      await Bun.sleep(1);
    });
    expect(screen.getByText("__jl.log(1, const a = 5);")).toBeTruthy();
    expect(api.transpiled).toHaveBeenCalledWith("t1", false);

    api.transpiled.mockImplementation(async () => ({ code: "__jl.log(1, 42);", source: SOURCE }));
    await act(async () => {
      // "transpiling" is how a run announces itself: `applyRunState` drops any other state for a runId it has
      // never seen ("later states for unknown runs are stale messages"), so an "evaluating" here would be a no-op.
      store.getState().receiveState("run-2", "transpiling");
      await Bun.sleep(1);
    });
    expect(screen.getByText("__jl.log(1, 42);")).toBeTruthy();
  });

  test("the toggle re-requests the output without instrumentation", async () => {
    const { store, api } = setup();
    await act(async () => {
      render(<TranspiledPanel store={store} api={api} />);
      await Bun.sleep(1);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("checkbox", { name: strings.transpiled.hideInstrumentation }));
      await Bun.sleep(1);
    });
    expect(api.transpiled).toHaveBeenLastCalledWith("t1", true);
    expect(screen.getByText("const a = 5;")).toBeTruthy();
  });

  test("a tab that has never run says so instead of showing an empty box", async () => {
    const { store, api } = setup();
    api.transpiled.mockImplementation(async () => null);
    await act(async () => {
      render(<TranspiledPanel store={store} api={api} />);
      await Bun.sleep(1);
    });
    expect(screen.getByText(strings.transpiled.empty)).toBeTruthy();
  });

  /**
   * U-1: switching tabs re-runs the effect, but React keeps `entry` until the new request resolves. For that one
   * round trip the panel would otherwise render the PREVIOUS tab's transpiled output under the new tab, and --
   * because staleness compares the entry's `source` against the active buffer -- flash "Stale" at a tab that is
   * not stale. Every other test here uses a single tab, so nothing else can catch this.
   */
  test("a tab switch never shows the previous tab's output, or a false 'Stale', while the new request is in flight", async () => {
    const { store, api } = setup();
    await act(async () => {
      render(<TranspiledPanel store={store} api={api} />);
      await Bun.sleep(1);
    });
    expect(screen.getByText("__jl.log(1, const a = 5);")).toBeTruthy();

    // Held unresolved on purpose: this IS the window the bug lives in, and letting it resolve would race the
    // assertions against the correct output arriving.
    api.transpiled.mockImplementation(() => new Promise<{ code: string; source: string } | null>(() => {}));
    await act(async () => {
      // A different buffer from t1's SOURCE, so t1's `source` compared against it would read as stale.
      store.getState().openTab(createTab({ id: "t2" }), "const b = 9");
      await Bun.sleep(1);
    });

    expect(api.transpiled).toHaveBeenLastCalledWith("t2", false);
    expect(screen.queryByText("__jl.log(1, const a = 5);")).toBeNull();
    expect(screen.queryByText(strings.transpiled.stale)).toBeNull();
    expect(screen.getByText(strings.transpiled.empty)).toBeTruthy();
  });

  /**
   * REGRESSION GUARD (ruling R-M5b-D3/D4-FIX). The side bar is the one component two milestones each add a branch
   * to, and NEITHER branch is enforced by the type system: `panel` is the whole `AppState["sideBarPanel"]` union, so
   * a SideBar that has forgotten a member still compiles and silently renders the AI Chat placeholder for it. That
   * is exactly how M5b Task 9's original rewrite would have deleted M5a's transpiled panel -- with no type error and
   * no merge conflict. This test is what makes a dropped branch visible.
   */
  test("the side bar renders a panel for every member of the union, and the placeholder only for AI Chat", async () => {
    const { store, api } = setup();
    const dialogs = { confirm: async () => "cancel" };
    const actions = { insert: () => {}, insertInNewTab: async () => {} };
    const show = (panel: AppState["sideBarPanel"]) =>
      render(<SideBar panel={panel} store={store} api={api} dialogs={dialogs} actions={actions} />).container;

    // Seeded with empty divs rather than null, so a render that never happened FAILS these assertions instead of
    // satisfying them: an empty div has neither a panel nor the placeholder text.
    let transpiled: HTMLElement = document.createElement("div");
    let snippets: HTMLElement = document.createElement("div");
    let ai: HTMLElement = document.createElement("div");
    await act(async () => {
      transpiled = show("transpiled");
      snippets = show("snippets");
      ai = show("ai");
      await Bun.sleep(1);
    });

    // M5a's branch. THIS is the assertion that dies if a SideBar rewrite drops `if (panel === "transpiled")`.
    expect(transpiled.querySelector(".transpiled-panel")).not.toBeNull();
    expect(transpiled.textContent).toContain("__jl.log(1, const a = 5);");
    expect(transpiled.querySelector(".snippets-panel")).toBeNull();

    // M5b's branch, and that it did not swallow M5a's.
    expect(snippets.querySelector(".snippets-panel")).not.toBeNull();
    expect(snippets.querySelector(".transpiled-panel")).toBeNull();

    // The placeholder is AI Chat's alone now: "snippets" stopped being a placeholder when the panel landed.
    expect(ai.textContent).toContain(strings.shell.sideBarPlaceholder);
    expect(ai.querySelector(".transpiled-panel")).toBeNull();
    expect(ai.querySelector(".snippets-panel")).toBeNull();
    // ...and the two real panels are NOT the placeholder, so a fallback that swallowed a branch fails here too.
    expect(transpiled.textContent).not.toContain(strings.shell.sideBarPlaceholder);
    expect(snippets.textContent).not.toContain(strings.shell.sideBarPlaceholder);

    // Every panel keeps the `side-bar` class: apps/ui/isolated/app.test.tsx decides the side bar is open by it.
    for (const container of [transpiled, snippets, ai]) {
      expect(container.querySelector(".side-bar")).not.toBeNull();
    }
  });

  /**
   * R-M5a-7: the panel must say when what it shows is output for code the user has since changed, and the
   * comparison is against the source Main actually transpiled (the response's `source`) -- not a timestamp, and
   * not the UI's own "last thing I sent to run.start", which is wrong whenever that last run failed to transpile.
   */
  test("says it is stale once the buffer differs from the source that produced the output, and clears on the next run", async () => {
    const { store, api } = setup();
    await act(async () => {
      render(<TranspiledPanel store={store} api={api} />);
      await Bun.sleep(1);
    });
    expect(screen.queryByText(strings.transpiled.stale)).toBeNull();

    await act(async () => {
      store.getState().editCode("const a = 6");
      await Bun.sleep(1);
    });
    expect(screen.getByText(strings.transpiled.stale)).toBeTruthy();
    // An edit is not a run: nothing was re-requested, and what is on screen is still the old run's output.
    expect(api.transpiled).toHaveBeenCalledTimes(1);
    expect(screen.getByText("__jl.log(1, const a = 5);")).toBeTruthy();

    api.transpiled.mockImplementation(async () => ({
      code: "__jl.log(1, const a = 6);",
      source: "const a = 6",
    }));
    await act(async () => {
      store.getState().receiveState("run-2", "transpiling");
      await Bun.sleep(1);
    });
    expect(screen.queryByText(strings.transpiled.stale)).toBeNull();
    expect(screen.getByText("__jl.log(1, const a = 6);")).toBeTruthy();
  });
});
