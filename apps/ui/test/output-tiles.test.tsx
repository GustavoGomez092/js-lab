import { describe, expect, spyOn, test } from "bun:test";
import { tabPatchSchema } from "@jslab/rpc-schema";
import { createTab, defaultSession, defaultSettings, type Runtime, type TabState } from "@jslab/shared";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { useStore } from "zustand";
import type { MainApi } from "../src/api";
import { OutputTiles } from "../src/output/OutputTiles";
import { WebViewHosts, type WebviewDock } from "../src/output/WebViewHosts";
import { SplitPane } from "../src/shell/SplitPane";
import { StatusBar } from "../src/shell/StatusBar";
import { computeTabPatch } from "../src/shell/tab-patch";
import { type AppStore, createAppStore } from "../src/state/store";
import { strings } from "../src/strings";
import { createFakeApi } from "./fake-api";

/** A fully-formed tab, so overriding `layout.tiles` never has to satisfy the schema's own defaults by hand twice. */
function tabWith(id: string, overrides: { runtime?: Runtime; tiles?: Partial<TabState["layout"]["tiles"]> }): TabState {
  return createTab({
    id,
    runtime: overrides.runtime ?? "browser",
    layout: {
      orientation: "horizontal",
      editorSize: 55,
      outputVisible: true,
      tiles: {
        arrangement: "stacked",
        order: ["console", "webview"],
        webviewVisible: false,
        consoleSize: 55,
        ...overrides.tiles,
      },
    },
  });
}

/**
 * Fix round 2 (N2): a docked tile's own `aria-hidden="false"` (`WebViewTile.tsx`) means nothing if an ANCESTOR
 * carries `aria-hidden="true"` -- that attribute removes the whole subtree from the accessibility tree, and a
 * descendant's own `aria-hidden="false"` cannot re-expose it. Checking the element's own attribute (as the
 * pre-fix tests did) proves nothing about real exposure; this checks the whole chain, including itself.
 */
function exposed(element: Element): boolean {
  return element.closest('[aria-hidden="true"]') === null;
}

function hydrated(overrides: Parameters<typeof tabWith>[1] = {}) {
  const store = createAppStore();
  store.getState().hydrate({
    settings: defaultSettings(),
    session: defaultSession(() => tabWith("t1", overrides)),
    buffers: { t1: "" },
    safeMode: { active: false, reason: null },
    versions: { app: "0", bun: "1.4.0" },
  });
  return store;
}

/** `OutputTiles` and `WebViewHosts`, wired the same trivial way `App.tsx` wires them, with no outer split -- for
 * tests that don't care about the Output panel's own visibility. */
function renderTiles(store: AppStore, api: MainApi) {
  function Harness() {
    const [dock, setDock] = useState<WebviewDock | null>(null);
    return (
      <>
        <OutputTiles store={store} api={api} onWebviewDock={setDock} />
        <WebViewHosts store={store} dock={dock} />
      </>
    );
  }
  return render(<Harness />);
}

/**
 * Mirrors `App.tsx`'s real composition exactly (fix round 1): the outer Editor/Output `SplitPane`, its `second`
 * slot holding `OutputTiles`, and `WebViewHosts` as a *sibling* of that `SplitPane` -- not inside it -- receiving
 * the dock state `OutputTiles` reports. This is deliberately not a reimplementation of any logic under test: both
 * `OutputTiles` and `WebViewHosts` are the real production components; this only wires them the same two-line way
 * `App.tsx` does, so tests can exercise hiding Output (`SplitPane`'s own hide-on-`false` path) without rendering
 * the rest of `App` (Editor/Monaco included). Used only where that outer split matters (F1a); everything else
 * uses the simpler `renderTiles` above, since the outer split contributes its own separator otherwise.
 */
function renderArea(store: AppStore, api: MainApi) {
  function Harness() {
    const outputVisible = useStore(store, (s) => s.tab?.layout.outputVisible ?? true);
    const [dock, setDock] = useState<WebviewDock | null>(null);
    return (
      <>
        <SplitPane
          orientation="horizontal"
          size={50}
          secondVisible={outputVisible}
          onResize={() => {}}
          onReset={() => {}}
          first={<div />}
          second={<OutputTiles store={store} api={api} onWebviewDock={setDock} />}
        />
        <WebViewHosts store={store} dock={dock} />
      </>
    );
  }
  return render(<Harness />);
}

describe("OutputTiles / WebViewHosts", () => {
  test("a bun tab renders only the Console tile -- no split, no <electrobun-webview> anywhere (spec §7.1)", () => {
    const store = hydrated({ runtime: "bun" });
    const { api } = createFakeApi();
    renderTiles(store, api);
    expect(screen.getByRole("region", { name: strings.output.region })).toBeTruthy();
    expect(screen.queryByRole("separator")).toBeNull();
    expect(document.querySelector("electrobun-webview")).toBeNull();
    expect(screen.queryByTestId("webview-tile-t1")).toBeNull();
  });

  test("a browser-mode tab's Web View starts parked (hidden by default), with no dishonest divider (fix round 1, F4)", () => {
    const store = hydrated({ runtime: "browser" });
    const { api } = createFakeApi();
    renderTiles(store, api);
    // Default webviewVisible is false: no split at all, same shape as a bun tab's console-only render, so there
    // is no separator advertising a pane that isn't there (F4 -- output-tiles.test.tsx:58 formerly enshrined one).
    expect(screen.queryByRole("separator")).toBeNull();
    // But the host itself exists and is mounted, not merely absent -- parked, not destroyed. It always lives
    // inside .webview-parking (WebViewTile never moves in the DOM -- see WebViewTile.tsx); aria-hidden is what
    // actually distinguishes docked from parked.
    const tile = screen.getByTestId("webview-tile-t1");
    expect(tile.getAttribute("aria-hidden")).toBe("true");
    expect(tile.closest(".webview-parking")).toBeTruthy();
    expect(tile.querySelector("electrobun-webview")).toBeTruthy();
  });

  test("hiding the Output panel parks the webview instead of destroying it, and redocks the same node (fix round 1, F1a)", () => {
    const store = hydrated({ runtime: "browser", tiles: { webviewVisible: true } });
    const { api } = createFakeApi();
    renderArea(store, api);
    const before = screen.getByTestId("webview-tile-t1");
    const beforeWebview = before.querySelector("electrobun-webview");
    expect(exposed(before)).toBe(true);

    act(() => store.getState().toggleOutputVisible());
    // Reachable from the View menu's "Output" item and the view.toggleOutput command (menu.ts:208).
    expect(screen.queryByRole("region", { name: strings.output.region })).toBeNull();
    const parked = screen.getByTestId("webview-tile-t1");
    expect(parked).toBe(before); // same node -- not destroyed and recreated
    expect(parked.querySelector("electrobun-webview")).toBe(beforeWebview);
    expect(parked.getAttribute("aria-hidden")).toBe("true");

    act(() => store.getState().toggleOutputVisible());
    const redocked = screen.getByTestId("webview-tile-t1");
    expect(redocked).toBe(before);
    expect(redocked.querySelector("electrobun-webview")).toBe(beforeWebview);
    expect(exposed(redocked)).toBe(true);
  });

  test("switching to a bun tab parks the other tab's webview instead of destroying it; the bun tab never creates one (fix round 1, F1b)", () => {
    const store = hydrated({ runtime: "browser", tiles: { webviewVisible: true } });
    store.getState().openTab(tabWith("t2", { runtime: "bun" }), "");
    store.getState().activateTab("t1");
    const { api } = createFakeApi();
    renderTiles(store, api);
    const before = screen.getByTestId("webview-tile-t1");
    const beforeWebview = before.querySelector("electrobun-webview");
    expect(exposed(before)).toBe(true);

    act(() => store.getState().activateTab("t2"));
    expect(document.querySelectorAll("electrobun-webview")).toHaveLength(1); // still only t1's -- t2 never got one
    const parked = screen.getByTestId("webview-tile-t1");
    expect(parked).toBe(before);
    expect(parked.querySelector("electrobun-webview")).toBe(beforeWebview);
    expect(parked.getAttribute("aria-hidden")).toBe("true");
    expect(parked.closest(".webview-parking")).toBeTruthy();

    act(() => store.getState().activateTab("t1"));
    const redocked = screen.getByTestId("webview-tile-t1");
    expect(redocked).toBe(before);
    expect(redocked.querySelector("electrobun-webview")).toBe(beforeWebview);
    expect(exposed(redocked)).toBe(true);
  });

  test("two browser tabs each keep their own persistent host; only the active tab's is ever docked (fix round 1, F2)", () => {
    const store = hydrated({ runtime: "browser", tiles: { webviewVisible: true } });
    store.getState().openTab(tabWith("t2", { runtime: "browser", tiles: { webviewVisible: true } }), "");
    store.getState().activateTab("t1");
    const { api } = createFakeApi();
    renderTiles(store, api);

    const tile1Before = screen.getByTestId("webview-tile-t1");
    const tile2Before = screen.getByTestId("webview-tile-t2");
    const webview1 = tile1Before.querySelector("electrobun-webview");
    const webview2 = tile2Before.querySelector("electrobun-webview");
    expect(webview1).toBeTruthy();
    expect(webview2).toBeTruthy();
    expect(webview1).not.toBe(webview2); // distinct hosts, not one shared instance
    expect(exposed(tile1Before)).toBe(true); // t1 active: docked and genuinely exposed
    expect(tile2Before.getAttribute("aria-hidden")).toBe("true"); // t2 backgrounded: parked, not gone

    act(() => store.getState().activateTab("t2"));
    const tile1After = screen.getByTestId("webview-tile-t1");
    const tile2After = screen.getByTestId("webview-tile-t2");
    expect(tile1After).toBe(tile1Before);
    expect(tile2After).toBe(tile2Before);
    expect(tile1After.querySelector("electrobun-webview")).toBe(webview1);
    expect(tile2After.querySelector("electrobun-webview")).toBe(webview2);
    expect(tile1After.getAttribute("aria-hidden")).toBe("true"); // now backgrounded
    expect(exposed(tile2After)).toBe(true); // now active, genuinely exposed
  });

  test("toggling Web View visible collapses/expands the tile without recreating its <electrobun-webview> (M0-S4; restored, fix round 2 N5)", () => {
    const store = hydrated({ runtime: "browser" }); // default webviewVisible: false
    const { api } = createFakeApi();
    renderTiles(store, api);
    const before = screen.getByTestId("webview-tile-t1");
    const beforeWebview = before.querySelector("electrobun-webview");
    expect(before.getAttribute("aria-hidden")).toBe("true");

    act(() => store.getState().toggleWebviewVisible());
    const docked = screen.getByTestId("webview-tile-t1");
    expect(docked).toBe(before); // same node -- not destroyed and recreated
    expect(docked.querySelector("electrobun-webview")).toBe(beforeWebview);
    expect(exposed(docked)).toBe(true);

    act(() => store.getState().toggleWebviewVisible());
    const parked = screen.getByTestId("webview-tile-t1");
    expect(parked).toBe(before);
    expect(parked.querySelector("electrobun-webview")).toBe(beforeWebview);
    expect(parked.getAttribute("aria-hidden")).toBe("true");
  });

  test("an order swap while docked re-targets the host onto the new, connected dock node (fix round 2, N1)", () => {
    const store = hydrated({ runtime: "browser", tiles: { webviewVisible: true, order: ["console", "webview"] } });
    const { api } = createFakeApi();
    renderTiles(store, api);

    const webviewBefore = screen.getByTestId("webview-tile-t1").querySelector("electrobun-webview");
    const dockBefore = document.querySelector(".webview-tile-dock");
    expect(dockBefore).toBeTruthy();

    // Records which elements actually get measured, without changing jsdom's own (zero-rect) behavior -- the
    // fix's observable signature is that the NEW dock node gets measured after the swap, not just the old one.
    const measured = new Set<Element>();
    const original = Element.prototype.getBoundingClientRect;
    const spy = spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      measured.add(this);
      return original.call(this);
    });
    try {
      // No `order` control exists in the UI yet (Task 15 adds one) -- drive the swap directly through the store,
      // the same shape a hand-edited session.json or a future arrangement control would produce.
      act(() => {
        const tab = store.getState().tab as TabState;
        store.getState().applyTabUpdate({
          ...tab,
          layout: { ...tab.layout, tiles: { ...tab.layout.tiles, order: ["webview", "console"] } },
        });
      });
    } finally {
      spy.mockRestore();
    }

    const dockAfter = document.querySelector(".webview-tile-dock");
    expect(dockAfter).toBeTruthy();
    // Confirms the swap genuinely remounted the placeholder (SplitPane sees a different element type at that
    // position) -- the trigger this test exists to exercise, not just a no-op re-render.
    expect(dockAfter).not.toBe(dockBefore);
    expect(document.body.contains(dockAfter)).toBe(true);
    // The old, pre-fix bug: WebViewHosts kept reporting `dockBefore` (now detached) forever, because the
    // reporting effect's deps didn't include `order`. The fix: a callback ref reports on every attach, so the
    // host re-measures against whatever node is actually in the tree now.
    expect(measured.has(dockAfter as Element)).toBe(true);

    const tile = screen.getByTestId("webview-tile-t1");
    expect(tile.querySelector("electrobun-webview")).toBe(webviewBefore); // still the same host, never recreated
    expect(exposed(tile)).toBe(true); // still genuinely docked, not silently orphaned
  });

  test("resetConsoleSize resets to the tiles schema default (55), not editorSize's own reset value (fix round 1, F8)", () => {
    const store = hydrated({ runtime: "browser", tiles: { webviewVisible: true, consoleSize: 20 } });
    act(() => store.getState().resetConsoleSize());
    expect(store.getState().tab?.layout.tiles.consoleSize).toBe(55);
  });

  test("arrangement maps to the split's orientation, and order controls which tile's dock renders first", () => {
    const stacked = hydrated({ runtime: "browser", tiles: { webviewVisible: true, arrangement: "stacked" } });
    const { api } = createFakeApi();
    const { container, rerender } = render(<OutputTiles store={stacked} api={api} onWebviewDock={() => {}} />);
    expect(container.querySelector(".split-vertical")).toBeTruthy();

    const sideBySide = hydrated({ runtime: "browser", tiles: { webviewVisible: true, arrangement: "side-by-side" } });
    rerender(<OutputTiles store={sideBySide} api={api} onWebviewDock={() => {}} />);
    expect(container.querySelector(".split-horizontal")).toBeTruthy();

    // Default order (["console", "webview"]): the Console region is the first, sized pane.
    const panes = container.querySelectorAll(".split-pane");
    expect(panes[0]?.querySelector(`[aria-label="${strings.output.region}"]`)).toBeTruthy();

    // Reversed order: the webview's dock renders first instead.
    const reversed = hydrated({
      runtime: "browser",
      tiles: { webviewVisible: true, order: ["webview", "console"] },
    });
    rerender(<OutputTiles store={reversed} api={api} onWebviewDock={() => {}} />);
    const reversedPanes = container.querySelectorAll(".split-pane");
    expect(reversedPanes[0]?.querySelector(".webview-tile-dock")).toBeTruthy();
  });

  test("dragging the split updates consoleSize, converted for which side Console renders on", () => {
    const store = hydrated({ runtime: "browser", tiles: { webviewVisible: true, order: ["console", "webview"] } });
    const { api } = createFakeApi();
    const { rerender } = render(<OutputTiles store={store} api={api} onWebviewDock={() => {}} />);
    fireEvent.pointerDown(screen.getByRole("separator"));
    fireEvent.pointerMove(window, { clientX: 999999, clientY: 999999 });
    fireEvent.pointerUp(window);
    // jsdom's layout rect is all zeros, so the ratio is +Infinity; setConsoleSize's own clamp (10-90) is what
    // turns that into a deterministic, in-range value.
    expect(store.getState().tab?.layout.tiles.consoleSize).toBe(90);

    // With Console second, the same onResize(size) call must convert to the other side before storing.
    const reversed = hydrated({
      runtime: "browser",
      tiles: { webviewVisible: true, order: ["webview", "console"], consoleSize: 55 },
    });
    rerender(<OutputTiles store={reversed} api={api} onWebviewDock={() => {}} />);
    act(() => {
      fireEvent.keyDown(screen.getByRole("separator"), { key: "ArrowRight" });
    });
    // ArrowRight steps `first`'s size (webview's share) up by 2, so Console's own share goes down by 2.
    expect(reversed.getState().tab?.layout.tiles.consoleSize).toBe(53);
  });

  test("the status bar's Web View toggle is disabled with a reason for the Bun runtime (R-M4-T8-DISABLED-1)", () => {
    const store = hydrated({ runtime: "bun" });
    render(<StatusBar store={store} onToggleLayout={() => {}} runKeys="⌘R" />);
    const toggle = screen.getByRole("button", { name: strings.shell.webView.show });
    expect(toggle.hasAttribute("disabled")).toBe(true);
    expect(toggle.getAttribute("title")).toBe(strings.shell.webView.unavailable);
  });

  test("a Bun tab's disabled toggle never offers to hide what it can't show, even if webviewVisible is stale (fix round 1, F6)", () => {
    // A tab can carry webviewVisible: true from before its runtime was switched to bun -- the label must still
    // say "Show", not "Hide", since there is nothing to hide.
    const store = hydrated({ runtime: "bun", tiles: { webviewVisible: true } });
    render(<StatusBar store={store} onToggleLayout={() => {}} runKeys="⌘R" />);
    expect(screen.getByRole("button", { name: strings.shell.webView.show })).toBeTruthy();
    expect(screen.queryByRole("button", { name: strings.shell.webView.hide })).toBeNull();
  });

  test("the status bar's Web View toggle flips webviewVisible for a runtime that supports it", () => {
    const store = hydrated({ runtime: "browser" });
    render(<StatusBar store={store} onToggleLayout={() => {}} runKeys="⌘R" />);
    const toggle = screen.getByRole("button", { name: strings.shell.webView.show });
    expect(toggle.hasAttribute("disabled")).toBe(false);
    fireEvent.click(toggle);
    expect(store.getState().tab?.layout.tiles.webviewVisible).toBe(true);
    expect(screen.getByRole("button", { name: strings.shell.webView.hide })).toBeTruthy();
  });

  test("a tiles change survives the trip from the UI's tab.patch through Main's tabPatchSchema (R-M4-T8-PATCH-1)", () => {
    const before = tabWith("t1", { runtime: "browser" });
    const next: TabState = {
      ...before,
      layout: { ...before.layout, tiles: { ...before.layout.tiles, webviewVisible: true, consoleSize: 40 } },
    };
    const patch = computeTabPatch(before, next);
    expect(patch).not.toBeNull();
    // The real Main-side validator (packages/rpc-schema): if `tiles` were missing from its `layout` whitelist, it
    // would be stripped here silently -- this assertion is what would have caught that.
    const parsed = tabPatchSchema.parse({ tabId: before.id, patch });
    expect(parsed.patch.layout?.tiles).toEqual({
      arrangement: "stacked",
      order: ["console", "webview"],
      webviewVisible: true,
      consoleSize: 40,
    });
    expect(computeTabPatch(before, before)).toBeNull();
  });
});
