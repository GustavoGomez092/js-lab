import { describe, expect, mock, spyOn, test } from "bun:test";
import { tabPatchSchema } from "@jslab/rpc-schema";
import { createTab, defaultSession, defaultSettings, type Runtime, type TabState } from "@jslab/shared";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { useStore } from "zustand";
import type { MainApi } from "../src/api";
import { CommandRegistry } from "../src/commands/registry";
import { createViewCommands } from "../src/commands/view-commands";
import { OutputTiles } from "../src/output/OutputTiles";
import { WebViewHosts, type WebviewDock } from "../src/output/WebViewHosts";
import type { WebviewElement } from "../src/output/webview-host";
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
        webviewVisible: false,
        consoleSize: 55,
        ...overrides.tiles,
      },
      muted: false,
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

/**
 * M4 Task 9a: `WebViewHosts` now hands every element it creates to the host registry, which drives the real
 * `<electrobun-webview>` API. Electrobun registers that custom element inside a webview's own page and its `on()`
 * keeps a private listener map (devkit `api/preload/webviewTag.ts`), so in this test DOM the tag is inert -- an
 * `addEventListener` stand-in would receive nothing in production either. These tests are about layout, parking
 * and DOM order, so they hand the component a real node that carries the contract without pretending to be a
 * webview; the contract itself is covered by `webview-host.test.ts` and `webview-hosts-wiring.test.tsx`.
 */
function fakeWebview(): HTMLElement & WebviewElement {
  const element = document.createElement("electrobun-webview") as HTMLElement & WebviewElement;
  const listeners = new Map<string, Set<(event: CustomEvent) => void>>();
  element.executeJavascript = () => {};
  element.reload = () => {};
  element.on = (event: string, listener: (event: CustomEvent) => void) => {
    const set = listeners.get(event) ?? new Set();
    listeners.set(event, set);
    set.add(listener);
  };
  element.off = (event: string, listener: (event: CustomEvent) => void) => void listeners.get(event)?.delete(listener);
  return element;
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
        <WebViewHosts store={store} dock={dock} api={api} createWebview={fakeWebview} />
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
 * uses the simpler `renderTiles` above, since the outer split contributes its own separator otherwise -- and
 * that second separator is precisely why both are now named: the F1a test below asserts the two are on screen
 * together with different accessible names. The label passed here mirrors `App.tsx`'s, but rendering this
 * harness cannot prove `App.tsx` itself passes it (nothing renders `<App>`); `label` being a REQUIRED prop is
 * what makes dropping it there a typecheck failure.
 */
function renderArea(store: AppStore, api: MainApi) {
  function Harness() {
    const outputVisible = useStore(store, (s) => s.tab?.layout.outputVisible ?? true);
    const [dock, setDock] = useState<WebviewDock | null>(null);
    return (
      <>
        <SplitPane
          orientation="horizontal"
          label={strings.shell.splitter.editorOutput}
          size={50}
          secondVisible={outputVisible}
          onResize={() => {}}
          onReset={() => {}}
          first={<div />}
          second={<OutputTiles store={store} api={api} onWebviewDock={setDock} />}
        />
        <WebViewHosts store={store} dock={dock} api={api} createWebview={fakeWebview} />
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

  test("a browser-mode tab whose Web View toggle was never switched on gets no live webview element (N4: lazy creation)", () => {
    const store = hydrated({ runtime: "browser" });
    const { api } = createFakeApi();
    renderTiles(store, api);
    // Default webviewVisible is false: no split at all, same shape as a bun tab's console-only render, so there
    // is no separator advertising a pane that isn't there (F4 -- output-tiles.test.tsx:58 formerly enshrined one).
    expect(screen.queryByRole("separator")).toBeNull();
    // Task 8 keyed the *live webview element* purely on the tab's runtime, so a browser tab got one whether or
    // not its own toggle was ever switched on. N4 (carried into Task 9): create it lazily, on first enable. The
    // lightweight tile wrapper itself still mounts immediately (M4 T9 fix round 1, M2 -- see WebViewTile.tsx's
    // doc comment for why: it establishes stable DOM order among tiles, which deferring the whole tile's mount
    // cannot reliably do once more than one is a portal into a shared container), but nothing expensive exists
    // inside it yet.
    const tile = screen.getByTestId("webview-tile-t1");
    expect(tile.querySelector("electrobun-webview")).toBeNull();
    expect(document.querySelector("electrobun-webview")).toBeNull();
  });

  test("switching the toggle on creates the webview element for the first time, parked and mounted (N4: lazy creation)", () => {
    const store = hydrated({ runtime: "browser" });
    const { api } = createFakeApi();
    renderTiles(store, api);
    expect(screen.getByTestId("webview-tile-t1").querySelector("electrobun-webview")).toBeNull();

    act(() => store.getState().toggleWebviewVisible());

    // Now docked (Output visible, toggle on): a real webview element exists inside the tile, which lives inside
    // .webview-parking (WebViewTile never moves in the DOM -- see WebViewTile.tsx), and is genuinely exposed --
    // aria-hidden is what distinguishes docked from parked, but this tab is docked.
    const tile = screen.getByTestId("webview-tile-t1");
    expect(tile.closest(".webview-parking")).toBeTruthy();
    expect(tile.querySelector("electrobun-webview")).toBeTruthy();
    expect(exposed(tile)).toBe(true);
  });

  test("hiding the Output panel parks the webview instead of destroying it, and redocks the same node (fix round 1, F1a)", () => {
    const store = hydrated({ runtime: "browser", tiles: { webviewVisible: true } });
    const { api } = createFakeApi();
    renderArea(store, api);

    // The exact situation the naming defect was about: a browser tab showing the Web View preview puts BOTH
    // splitters on screen -- the outer Editor/Output one and the inner Output/Web View one. Unnamed, each is
    // announced only as "separator, <value>" and they are indistinguishable. Order is DOM order: the outer
    // divider precedes the OutputTiles subtree that contains the inner one.
    // happy-dom has no accessibility tree, so this pins the names the role query resolves, not what any screen
    // reader says out loud.
    const separators = screen.getAllByRole("separator");
    expect(separators).toHaveLength(2);
    const names = separators.map((s) => s.getAttribute("aria-label"));
    expect(names).toEqual([strings.shell.splitter.editorOutput, strings.shell.splitter.outputWebView]);
    expect(new Set(names).size).toBe(2);

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

  test("toggling Web View visible off again parks the tile without destroying its <electrobun-webview> (M0-S4; restored, fix round 2 N5; N4 lazy creation)", () => {
    const store = hydrated({ runtime: "browser" }); // default webviewVisible: false
    const { api } = createFakeApi();
    renderTiles(store, api);
    // N4: the tile wrapper mounts immediately (M2), but no webview element exists before the first enable.
    expect(screen.getByTestId("webview-tile-t1").querySelector("electrobun-webview")).toBeNull();

    act(() => store.getState().toggleWebviewVisible());
    const docked = screen.getByTestId("webview-tile-t1");
    const dockedWebview = docked.querySelector("electrobun-webview");
    expect(dockedWebview).toBeTruthy();
    expect(exposed(docked)).toBe(true);

    // The Task 8 invariant this lazy-creation change must not weaken: once created, a host is never unmounted
    // for going back off -- only re-parked. Node identity (`toBe`), not mere presence, is what proves it.
    act(() => store.getState().toggleWebviewVisible());
    const parked = screen.getByTestId("webview-tile-t1");
    expect(parked).toBe(docked); // same node -- not destroyed and recreated
    expect(parked.querySelector("electrobun-webview")).toBe(dockedWebview);
    expect(parked.getAttribute("aria-hidden")).toBe("true");

    // And flipping it back on a second time reuses that same host again, not a fresh one.
    act(() => store.getState().toggleWebviewVisible());
    const redocked = screen.getByTestId("webview-tile-t1");
    expect(redocked).toBe(docked);
    expect(redocked.querySelector("electrobun-webview")).toBe(dockedWebview);
    expect(exposed(redocked)).toBe(true);
  });

  test("a docked tile re-measures through ResizeObserver when its placeholder's box changes, not only at mount (Task 8's central mechanism, unexercised by jsdom until now)", () => {
    // jsdom defines no ResizeObserver -- WebViewTile.tsx:75 early-returns without one, and until this test nothing
    // ever constructed a real one or fired its callback: the tracking claim was correct by reading the code, not
    // by executing it. Injecting a controllable fake exercises the real registration and re-measure path.
    // A plain mutable holder, not two separate `let`s: TypeScript can't see that `renderTiles` below (via React's
    // effects) is what invokes `FakeResizeObserver`'s constructor/`observe`, so a bare `let` narrows to its
    // initializer's literal type (`null`) at every read after -- a property on an object isn't narrowed that way.
    const captured: { observedTargets: Element[]; fire: (() => void) | null } = {
      observedTargets: [],
      fire: null,
    };
    class FakeResizeObserver {
      constructor(callback: () => void) {
        captured.fire = callback;
      }
      observe(target: Element) {
        captured.observedTargets.push(target);
      }
      unobserve() {}
      disconnect() {}
    }
    const globals = globalThis as { ResizeObserver?: unknown };
    const original = globals.ResizeObserver;
    globals.ResizeObserver = FakeResizeObserver;
    try {
      const store = hydrated({ runtime: "browser", tiles: { webviewVisible: true } });
      const { api } = createFakeApi();
      renderTiles(store, api);

      const dockNode = document.querySelector(".webview-tile-dock");
      expect(dockNode).toBeTruthy();
      // The dock node itself is observed -- along with each of its ancestors, so a size change anywhere in the
      // chain that positions it re-measures too (pinned by `webview-tile-tracking.test.tsx`).
      expect(captured.observedTargets).toContain(dockNode as Element);
      expect(captured.fire).toBeTruthy();

      const tile = screen.getByTestId("webview-tile-t1");
      const rect = { top: 12, left: 34, width: 500, height: 600, right: 0, bottom: 0, x: 34, y: 12, toJSON() {} };
      const rectSpy = spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(rect);
      try {
        // Simulates a real ResizeObserver firing after the split was dragged or the window resized -- the case
        // jsdom's absence of the API left entirely unexercised (spec §7.1 / WebViewTile.tsx's own doc comment).
        act(() => captured.fire?.());
        expect(tile.style.top).toBe("12px");
        expect(tile.style.left).toBe("34px");
        expect(tile.style.width).toBe("500px");
        expect(tile.style.height).toBe("600px");
      } finally {
        rectSpy.mockRestore();
      }
    } finally {
      globals.ResizeObserver = original;
    }
  });

  // Named for exactly what it proves. DOM order among tiles is *mount* order, which coincides with tab order only
  // while tabs become web-capable in tab order -- Task 9's re-review demonstrated three divergences against the
  // real components (a tab switched `bun`→`browser` later, a new tab opened while an earlier one is active, and
  // `reorderTabs`). A name claiming tiles track tab order would assert a property the codebase is known not to
  // have, and would be cited as if it did.
  test("enable order does not determine tile DOM order (M4 T9 fix round 1, M2)", () => {
    const store = hydrated({ runtime: "browser" }); // t1
    store.getState().openTab(tabWith("t2", { runtime: "browser" }), "");
    store.getState().activateTab("t1");
    const { api } = createFakeApi();
    renderTiles(store, api);

    // Both tiles are already mounted at this point, in tab order (t1 opened before t2) -- mounting is driven by
    // tab order alone (`webTabs`, WebViewHosts.tsx), never by enable order. Enabling t2 before t1, as two separate
    // commits, must not reorder them: DOM order decides stacking among equal-z-index fixed elements, exactly the
    // question the follow-up task's compositor check must settle in a real run.
    act(() => {
      store.getState().activateTab("t2");
      store.getState().toggleWebviewVisible();
    });
    act(() => {
      store.getState().activateTab("t1");
      store.getState().toggleWebviewVisible();
    });

    const tiles = [...document.querySelectorAll('[data-testid^="webview-tile-"]')].map((el) =>
      el.getAttribute("data-testid"),
    );
    expect(tiles).toEqual(["webview-tile-t1", "webview-tile-t2"]);
  });

  test("switching a tab's runtime away from and back to a web-capable one tears the old host down and creates a fresh one (M4 T9 fix round 1, N1)", () => {
    // Newly reachable with lazy creation: before Task 9 a user could not switch a tab's runtime back to a
    // browser one (runtime was fixed at tab creation), so browser -> bun -> browser was unreachable. It is not a
    // violation of the never-unmount invariant -- the tab genuinely stops being web-capable when it becomes
    // `bun` (Task 8's own filter already excluded `bun` tabs), so losing the host and its page state here is
    // accepted behaviour, not a bug. This pins that it actually tears down and rebuilds, rather than silently
    // keeping a stale, invisible host around.
    const store = hydrated({ runtime: "browser", tiles: { webviewVisible: true } });
    const { api } = createFakeApi();
    renderTiles(store, api);

    const before = screen.getByTestId("webview-tile-t1");
    const webviewBefore = before.querySelector("electrobun-webview");
    expect(webviewBefore).toBeTruthy();

    act(() => store.getState().setRuntime("bun"));
    // bun has no Web View at all (spec §7.1): the host is gone, not merely parked.
    expect(screen.queryByTestId("webview-tile-t1")).toBeNull();
    expect(document.querySelector("electrobun-webview")).toBeNull();

    act(() => store.getState().setRuntime("browser"));
    // Switched back, but webviewVisible was never re-armed by a runtime switch (only the toggle sets it) -- the
    // tab's tiles.webviewVisible was already true from hydration and untouched by setRuntime, so the tile exists
    // again immediately, parked (not docked), with a brand new host.
    const after = screen.getByTestId("webview-tile-t1");
    const webviewAfter = after.querySelector("electrobun-webview");
    expect(webviewAfter).toBeTruthy();
    expect(after).not.toBe(before); // a fresh host, not the torn-down one
    expect(webviewAfter).not.toBe(webviewBefore);
  });

  /**
   * R-WEBVIEW-TAB-1's central mechanism, and the one most likely to fail silently: there is exactly ONE
   * `<electrobun-webview>` per tab, and exactly one dock node it is pointed at. Full screen and the preview strip
   * cannot each render their own dock -- two would leave the host tracking one while the other sat blank, with no
   * error anywhere. So the single node has to MOVE, which is a React remount (a different parent), which is
   * exactly what `OutputTiles`'s callback ref exists to survive.
   *
   * This is the successor to fix round 2's `order`-swap test: the same remount, now reached through the UI rather
   * than only a hand-edited session.json.
   */
  test("the Web View tab moves the ONE dock node into the output panel and back, never duplicating or orphaning it", () => {
    const store = hydrated({ runtime: "browser", tiles: { webviewVisible: true } });
    const { api } = createFakeApi();
    renderTiles(store, api);

    const docks = () => document.querySelectorAll(".webview-tile-dock");
    const region = `[aria-label="${strings.output.region}"]`;
    const webviewBefore = screen.getByTestId("webview-tile-t1").querySelector("electrobun-webview");
    expect(webviewBefore).toBeTruthy();

    // The preview: one dock, in the split's second pane, below the console, with the divider on screen.
    expect(docks().length).toBe(1);
    const dockBefore = docks()[0] as Element;
    expect(dockBefore.closest(".split-pane")).toBeTruthy();
    expect(dockBefore.closest(region)).toBeNull();
    expect(screen.getByRole("separator")).toBeTruthy();

    // Records which elements actually get measured, without changing happy-dom's own (zero-rect) behaviour -- the
    // observable signature of a correct move is that the NEW node gets measured, not just the old one.
    const measured = new Set<Element>();
    const original = Element.prototype.getBoundingClientRect;
    const spy = spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      measured.add(this);
      return original.call(this);
    });
    try {
      act(() => store.getState().setOutputView("webview"));
    } finally {
      spy.mockRestore();
    }

    // Still exactly ONE dock -- the assertion the whole design turns on.
    expect(docks().length).toBe(1);
    const dockAfter = docks()[0] as Element;
    // A genuine remount, not a re-render: it moved to a different parent, so React built a new node and really
    // discarded the old one (a detached-but-still-referenced node is the failure mode being excluded here).
    expect(dockAfter).not.toBe(dockBefore);
    expect(document.body.contains(dockBefore)).toBe(false);
    expect(document.body.contains(dockAfter)).toBe(true);
    // It now fills the output panel; the split and its divider are gone, and the log list is hidden behind it.
    expect(dockAfter.closest(region)).toBeTruthy();
    expect(screen.queryByRole("separator")).toBeNull();
    expect(document.querySelector(".output-scroller")).toBeNull();
    // WebViewHosts was told about the NEW node. Were it still holding the detached old one, `dockAfter` would
    // never be measured and the webview would track a node that is no longer in the tree (it silently collapses
    // to 0x0 at the viewport origin).
    expect(measured.has(dockAfter)).toBe(true);
    // ...and the host itself was never destroyed and rebuilt on the way there.
    const tile = screen.getByTestId("webview-tile-t1");
    expect(tile.querySelector("electrobun-webview")).toBe(webviewBefore);
    expect(exposed(tile)).toBe(true);

    // ...and back again by choosing a filter, since the row behaves as one tab strip.
    act(() => store.getState().setOutputFilter("errors"));
    expect(docks().length).toBe(1);
    const dockBack = docks()[0] as Element;
    expect(dockBack).not.toBe(dockAfter);
    expect(dockBack.closest(".split-pane")).toBeTruthy();
    expect(screen.getByRole("separator")).toBeTruthy();
    expect(document.querySelector(".output-scroller")).toBeTruthy();
    const tileBack = screen.getByTestId("webview-tile-t1");
    expect(tileBack.querySelector("electrobun-webview")).toBe(webviewBefore);
    expect(exposed(tileBack)).toBe(true);
  });

  test("resetConsoleSize resets to the tiles schema default (55), not editorSize's own reset value (fix round 1, F8)", () => {
    const store = hydrated({ runtime: "browser", tiles: { webviewVisible: true, consoleSize: 20 } });
    act(() => store.getState().resetConsoleSize());
    expect(store.getState().tab?.layout.tiles.consoleSize).toBe(55);
  });

  // R-WEBVIEW-TAB-1 retired `arrangement`/`order`: the preview has exactly one shape now, so this pins that shape
  // rather than the mapping from two fields that no longer exist.
  test("the preview is always the bottom pane: a vertical split, Console first (R-WEBVIEW-TAB-1)", () => {
    const store = hydrated({ runtime: "browser", tiles: { webviewVisible: true } });
    const { api } = createFakeApi();
    const { container } = render(<OutputTiles store={store} api={api} onWebviewDock={() => {}} />);
    // "vertical" is SplitPane's stacked orientation (it measures clientY): the Web View sits below the console,
    // which is the "new area at the bottom" the design asks for -- never beside it.
    expect(container.querySelector(".split-vertical")).toBeTruthy();
    expect(container.querySelector(".split-horizontal")).toBeNull();
    const panes = container.querySelectorAll(".split-pane");
    expect(panes[0]?.querySelector(`[aria-label="${strings.output.region}"]`)).toBeTruthy();
    expect(panes[1]?.querySelector(".webview-tile-dock")).toBeTruthy();
    // This is the assertion that pins which name THIS call site passes: swapping it for the outer splitter's
    // name (or dropping the attribute in SplitPane) fails here.
    expect(screen.getByRole("separator", { name: strings.shell.splitter.outputWebView })).toBeTruthy();
  });

  test("the preview keeps its draggable divider, and consoleSize is stored without conversion", () => {
    const store = hydrated({ runtime: "browser", tiles: { webviewVisible: true } });
    const { api } = createFakeApi();
    const { rerender } = render(<OutputTiles store={store} api={api} onWebviewDock={() => {}} />);
    fireEvent.pointerDown(screen.getByRole("separator"));
    fireEvent.pointerMove(window, { clientX: 999999, clientY: 999999 });
    fireEvent.pointerUp(window);
    // happy-dom's layout rect is all zeros, so the ratio is +Infinity; setConsoleSize's own clamp (10-90) is what
    // turns that into a deterministic, in-range value.
    expect(store.getState().tab?.layout.tiles.consoleSize).toBe(90);

    // Console is always `first` now, so an ArrowRight step lands on the Console's own share unconverted. The
    // retired `order: ["webview", "console"]` would have made this 53 instead of 57 -- the conversion is gone
    // along with the field that could demand it.
    const stepped = hydrated({ runtime: "browser", tiles: { webviewVisible: true, consoleSize: 55 } });
    rerender(<OutputTiles store={stepped} api={api} onWebviewDock={() => {}} />);
    act(() => {
      fireEvent.keyDown(screen.getByRole("separator"), { key: "ArrowRight" });
    });
    expect(stepped.getState().tab?.layout.tiles.consoleSize).toBe(57);
  });

  test("a bun tab gets no Web View control at all (spec §7.1)", () => {
    const store = hydrated({ runtime: "bun" });
    const { api } = createFakeApi();
    renderTiles(store, api);
    expect(screen.queryByRole("button", { name: strings.output.webViewTab })).toBeNull();
    // ...and the filter row is still exactly its four filters, untouched by the Web View's absence.
    expect(screen.getAllByRole("radio")).toHaveLength(4);
  });

  /**
   * The accessibility decision, pinned. The row is NOT one five-member group: the four chips filter one list that
   * stays on screen, while the Web View control swaps the panel body. Modelling all five as radios (or as tabs)
   * would describe a structure that does not exist and would make the one control that changes the body
   * indistinguishable from the four that don't.
   */
  test("the filter row stays one radiogroup of four filters, with the Web View a separate pressed-state button", () => {
    const store = hydrated({ runtime: "browser", tiles: { webviewVisible: true } });
    const { api } = createFakeApi();
    renderTiles(store, api);

    const group = screen.getByRole("radiogroup", { name: strings.output.filterLabel });
    expect(group.querySelectorAll('[role="radio"]')).toHaveLength(4);
    const webView = screen.getByRole("button", { name: strings.output.webViewTab });
    // Outside the group -- which is what keeps "Output filter" an honest name for it.
    expect(group.contains(webView)).toBe(false);
    expect(webView.getAttribute("aria-pressed")).toBe("false");

    act(() => {
      fireEvent.click(webView);
    });
    expect(screen.getByRole("button", { name: strings.output.webViewTab }).getAttribute("aria-pressed")).toBe("true");
    // While the Web View is up, no filter reads as checked: the list it would filter is not on screen.
    expect(screen.getAllByRole("radio").map((radio) => radio.getAttribute("aria-checked"))).toEqual([
      "false",
      "false",
      "false",
      "false",
    ]);
  });

  test("selecting the Web View tab while the preview is hidden shows the Web View, full screen", () => {
    const store = hydrated({ runtime: "browser" }); // webviewVisible: false -- no preview, no dock
    const { api } = createFakeApi();
    renderTiles(store, api);
    expect(document.querySelector(".webview-tile-dock")).toBeNull();

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: strings.output.webViewTab }));
    });

    // "Shown" stays ONE fact -- the tab's own toggle, which the status bar and View menu read, and which arms
    // WebViewHosts' lazy element creation. Without it the dock would be on screen and the webview never built.
    expect(store.getState().tab?.layout.tiles.webviewVisible).toBe(true);
    expect(store.getState().outputView).toBe("webview");
    const dock = document.querySelector(".webview-tile-dock");
    expect(dock?.closest(`[aria-label="${strings.output.region}"]`)).toBeTruthy();
    expect(screen.queryByRole("separator")).toBeNull();
    expect(screen.getByTestId("webview-tile-t1").querySelector("electrobun-webview")).toBeTruthy();
  });

  test("toggling the Web View off while its tab is selected returns to the log list (the two must not fight)", () => {
    const store = hydrated({ runtime: "browser", tiles: { webviewVisible: true } });
    const registry = viewRegistry(store);
    const { api } = createFakeApi();
    renderTiles(store, api);
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: strings.output.webViewTab }));
    });
    expect(document.querySelector(".output-scroller")).toBeNull();

    act(() => {
      registry.execute("view.toggleWebView");
    });

    // Hidden means hidden: no dock anywhere, the log list is back, and the view choice went with it -- otherwise
    // the panel would go on showing a Web View the status bar has just started calling "Show Web View".
    expect(store.getState().tab?.layout.tiles.webviewVisible).toBe(false);
    expect(store.getState().outputView).toBe("console");
    expect(document.querySelector(".webview-tile-dock")).toBeNull();
    expect(document.querySelector(".output-scroller")).toBeTruthy();
  });

  test("the status bar's Web View toggle is disabled with a reason for the Bun runtime (R-M4-T8-DISABLED-1)", () => {
    const store = hydrated({ runtime: "bun" });
    render(<StatusBar store={store} onToggleLayout={() => {}} onToggleWebView={() => {}} runKeys="⌘R" />);
    const toggle = screen.getByRole("button", { name: strings.shell.webView.show });
    expect(toggle.hasAttribute("disabled")).toBe(true);
    expect(toggle.getAttribute("title")).toBe(strings.shell.webView.unavailable);
  });

  test("a Bun tab's disabled toggle never offers to hide what it can't show, even if webviewVisible is stale (fix round 1, F6)", () => {
    // A tab can carry webviewVisible: true from before its runtime was switched to bun -- the label must still
    // say "Show", not "Hide", since there is nothing to hide.
    const store = hydrated({ runtime: "bun", tiles: { webviewVisible: true } });
    render(<StatusBar store={store} onToggleLayout={() => {}} onToggleWebView={() => {}} runKeys="⌘R" />);
    expect(screen.getByRole("button", { name: strings.shell.webView.show })).toBeTruthy();
    expect(screen.queryByRole("button", { name: strings.shell.webView.hide })).toBeNull();
  });

  /** The registry the palette, the menu and the keybindings all dispatch through, wired as `App.tsx` wires it. */
  function viewRegistry(store: AppStore) {
    const { api } = createFakeApi();
    const registry = new CommandRegistry();
    registry.register(...createViewCommands(store, api));
    return registry;
  }

  test("the status bar's Web View toggle flips webviewVisible through the command the palette also runs", () => {
    const store = hydrated({ runtime: "browser" });
    const registry = viewRegistry(store);
    render(
      <StatusBar
        store={store}
        onToggleLayout={() => {}}
        onToggleWebView={() => registry.execute("view.toggleWebView")}
        runKeys="⌘R"
      />,
    );
    const toggle = screen.getByRole("button", { name: strings.shell.webView.show });
    expect(toggle.hasAttribute("disabled")).toBe(false);
    fireEvent.click(toggle);
    expect(store.getState().tab?.layout.tiles.webviewVisible).toBe(true);
    expect(screen.getByRole("button", { name: strings.shell.webView.hide })).toBeTruthy();
  });

  // One path, not two: the button must dispatch, never reach into the store itself, or the palette and the
  // button could drift apart (and only one of them would honour the command's enablement rule).
  test("the status bar's Web View button dispatches rather than touching the store itself", () => {
    const store = hydrated({ runtime: "browser" });
    const onToggleWebView = mock(() => {});
    render(<StatusBar store={store} onToggleLayout={() => {}} onToggleWebView={onToggleWebView} runKeys="⌘R" />);
    fireEvent.click(screen.getByRole("button", { name: strings.shell.webView.show }));
    expect(onToggleWebView).toHaveBeenCalledTimes(1);
    expect(store.getState().tab?.layout.tiles.webviewVisible).toBe(false);
  });

  test("the Web View command is disabled for a Bun tab, exactly as the button is", () => {
    const store = hydrated({ runtime: "bun" });
    expect(viewRegistry(store).execute("view.toggleWebView")).toBe("disabled");
    expect(store.getState().tab?.layout.tiles.webviewVisible).toBe(false);
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
    expect(parsed.patch.layout?.tiles).toEqual({ webviewVisible: true, consoleSize: 40 });
    expect(computeTabPatch(before, before)).toBeNull();
  });

  // Fix round 1, F1: the parallel guard for Task 15's `muted` -- without tab-patch.ts's `layoutChanged` check
  // naming it, computeTabPatch returns null for a mute-only change and it silently never reaches disk; without
  // ui-rpc.ts's tabPatchSchema whitelist naming it, Main would silently strip it in transit. One test for both.
  test("a muted change survives the trip from the UI's tab.patch through Main's tabPatchSchema (Task 15 fix round 1, F1)", () => {
    const before = tabWith("t1", { runtime: "browser" });
    const next: TabState = { ...before, layout: { ...before.layout, muted: true } };
    const patch = computeTabPatch(before, next);
    expect(patch).not.toBeNull();
    const parsed = tabPatchSchema.parse({ tabId: before.id, patch });
    expect(parsed.patch.layout?.muted).toBe(true);
  });
});
