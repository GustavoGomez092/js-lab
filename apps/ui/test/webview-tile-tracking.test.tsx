import { afterEach, describe, expect, test } from "bun:test";
import { createTab, defaultSession, defaultSettings, type TabState } from "@jslab/shared";
import { act, render } from "@testing-library/react";
import type { MainApi } from "../src/api";
import { WebViewHosts } from "../src/output/WebViewHosts";
import { webViewTileCounters } from "../src/output/WebViewTile";
import type { WebviewElement } from "../src/output/webview-host";
import { createAppStore } from "../src/state/store";
import { createFakeApi } from "./fake-api";

/**
 * The docked tile's rect has to track the dock wherever it goes -- not only when the dock *resizes*.
 *
 * A `ResizeObserver` fires on size changes and never on a move, so a dock repositioned by something above it in
 * the tree (a banner appearing, a pane relaying out, rows arriving) used to leave the `position: fixed` tile at
 * stale coordinates. That is not merely cosmetic: the native `<electrobun-webview>` surface inside the tile paints
 * above all HTML regardless of `z-index`, so a stale rect covers real content and no amount of layering hides it.
 *
 * **What this file can and cannot prove.** happy-dom has no layout engine: every `getBoundingClientRect()` is
 * zeros, and its `ResizeObserver` never invokes its callback (verified by probe -- it does not fire on `observe`,
 * nor after a size change). So these tests deliberately do NOT assert geometry, which would be vacuous here.
 * They assert the things that *are* observable: that each mechanism TRIGGERS a re-measure, that the equality guard
 * suppresses a no-op state commit, and that every observer and listener is disposed on unmount. Whether the
 * resulting coordinates are correct in a real compositor is a live-run question, not one this DOM can answer.
 *
 * `measures` counts every re-measure attempt and `rectCommits` only those that got past the guard, so the pair is
 * what separates "a trigger fired" from "React state was updated" (`WebViewTile.tsx`'s `counters`). Every
 * assertion is a DELTA against a snapshot: the counters are module-global and shared across the test process.
 */

function tabWith(id: string): TabState {
  return createTab({
    id,
    runtime: "browser",
    layout: {
      orientation: "horizontal",
      editorSize: 55,
      outputVisible: true,
      tiles: { arrangement: "stacked", order: ["console", "webview"], webviewVisible: true, consoleSize: 55 },
      muted: false,
    },
  });
}

function hydrated() {
  const store = createAppStore();
  store.getState().hydrate({
    settings: defaultSettings(),
    session: defaultSession(() => tabWith("t1")),
    buffers: { t1: "" },
    safeMode: { active: false, reason: null },
    versions: { app: "0", bun: "1.4.0" },
  });
  return store;
}

function fakeWebview(): HTMLElement & WebviewElement {
  const element = document.createElement("electrobun-webview") as HTMLElement & WebviewElement;
  element.executeJavascript = () => {};
  element.reload = () => {};
  element.on = () => {};
  element.off = () => {};
  return element;
}

/** Dock nodes are appended to `document.body`, so each test's own chain is `dock -> body -> html`. */
const created: HTMLDivElement[] = [];
function makeDockNode(): HTMLDivElement {
  const node = document.createElement("div");
  node.className = "webview-tile-dock";
  document.body.appendChild(node);
  created.push(node);
  return node;
}

afterEach(() => {
  for (const node of created.splice(0)) node.remove();
});

function renderDocked(api: MainApi, dockNode: HTMLDivElement) {
  const store = hydrated();
  return render(
    <WebViewHosts store={store} dock={{ tabId: "t1", node: dockNode }} api={api} createWebview={fakeWebview} />,
  );
}

/**
 * Lets a coalesced (`requestAnimationFrame`-deferred) re-measure run. happy-dom does schedule and run rAF
 * callbacks (verified by probe), so this is a real wait, not a no-op; `act` flushes any React update it produces.
 */
async function settleFrame(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
}

describe("a docked Web View tile re-measures when the dock MOVES, not only when it resizes", () => {
  /**
   * The user-reported case, in its general form: content is added to the page, the layout may have moved the dock,
   * and nothing about the dock's own box necessarily changed -- so a `ResizeObserver` on the dock sees nothing.
   * Fails without the `MutationObserver`: no trigger fires and the delta stays 0.
   */
  test("a structural DOM change re-measures, though the dock's own box never changed", async () => {
    const { api } = createFakeApi();
    renderDocked(api, makeDockNode());
    await settleFrame();

    const before = webViewTileCounters();
    const row = document.createElement("div");
    document.body.appendChild(row);
    await settleFrame();
    const after = webViewTileCounters();

    expect(after.measures).toBeGreaterThan(before.measures);
    row.remove();
  });

  /**
   * Scrolling never changes any element's size, so this is a move a `ResizeObserver` can never report. `scroll`
   * does not bubble from an element either, which is why the listener is registered in the capture phase -- a
   * bubble-phase listener on `window` would hear nothing here. Fails if that listener is dropped, or registered
   * without `true`.
   */
  test("a scroll anywhere in the document re-measures", async () => {
    const { api } = createFakeApi();
    const dockNode = makeDockNode();
    renderDocked(api, dockNode);
    await settleFrame();

    const before = webViewTileCounters();
    const scroller = document.createElement("div");
    document.body.appendChild(scroller);
    await settleFrame();
    const afterMount = webViewTileCounters();

    await act(async () => {
      scroller.dispatchEvent(new Event("scroll", { bubbles: false }));
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    const after = webViewTileCounters();

    // Measured against the post-append snapshot, so this is the scroll's own effect and not the append's.
    expect(after.measures).toBeGreaterThan(afterMount.measures);
    expect(afterMount.measures).toBeGreaterThan(before.measures - 1);
    scroller.remove();
  });

  /**
   * The decisive structural assertion: a move caused by an ANCESTOR resizing (a pane, a banner, the shell) leaves
   * the dock's own box untouched, so observing only the dock is exactly the gap. Fails if the observer loop is
   * reduced back to `observer.observe(dockNode)` -- `body` and `documentElement` would then be absent.
   */
  test("the ResizeObserver observes the dock's ancestors, not only the dock", async () => {
    const observed: Element[] = [];
    class FakeResizeObserver {
      constructor(_callback: () => void) {}
      observe(target: Element) {
        observed.push(target);
      }
      unobserve() {}
      disconnect() {}
    }
    const globals = globalThis as { ResizeObserver?: unknown };
    const original = globals.ResizeObserver;
    globals.ResizeObserver = FakeResizeObserver;
    try {
      const { api } = createFakeApi();
      const dockNode = makeDockNode();
      renderDocked(api, dockNode);
      await settleFrame();

      expect(observed).toContain(dockNode as Element);
      expect(observed).toContain(document.body as Element);
      expect(observed).toContain(document.documentElement as Element);
    } finally {
      globals.ResizeObserver = original;
    }
  });

  /**
   * The performance half of the fix. Every rect in this DOM is zeros, so every re-measure after the first is a
   * genuine no-op -- which makes this the one place a layout-less DOM can witness the guard working. Without the
   * four-number comparison, `setRect` receives a fresh object literal each time, `Object.is` never bails out, and
   * `rectCommits` climbs in step with `measures`.
   */
  test("an unchanged rect re-measures but commits nothing (the equality guard)", async () => {
    const { api } = createFakeApi();
    renderDocked(api, makeDockNode());
    await settleFrame();

    const before = webViewTileCounters();
    for (let i = 0; i < 5; i += 1) {
      const row = document.createElement("div");
      document.body.appendChild(row);
      await settleFrame();
      row.remove();
      await settleFrame();
    }
    const after = webViewTileCounters();

    expect(after.measures).toBeGreaterThan(before.measures);
    expect(after.rectCommits).toBe(before.rectCommits);
  });

  /**
   * Disposal, asserted by behaviour rather than by counting `disconnect` calls: after unmount a DOM change that
   * would certainly have re-measured a live tile must do nothing at all. Fails if the `MutationObserver`, the
   * scroll listener or the resize listener outlives the effect -- a leak that would also keep the unmounted tile's
   * closure (and its dock node) reachable for the window's life.
   */
  test("every observer and listener is disposed on unmount", async () => {
    const { api } = createFakeApi();
    const view = renderDocked(api, makeDockNode());
    await settleFrame();

    view.unmount();
    await settleFrame();

    const before = webViewTileCounters();
    const row = document.createElement("div");
    document.body.appendChild(row);
    const scroller = document.createElement("div");
    document.body.appendChild(scroller);
    scroller.dispatchEvent(new Event("scroll", { bubbles: false }));
    window.dispatchEvent(new Event("resize"));
    await settleFrame();
    const after = webViewTileCounters();

    expect(after.measures).toBe(before.measures);
    row.remove();
    scroller.remove();
  });

  /** The `ResizeObserver` itself is disconnected, not merely left unreferenced. */
  test("the ResizeObserver is disconnected on unmount", async () => {
    let disconnects = 0;
    class FakeResizeObserver {
      constructor(_callback: () => void) {}
      observe(_target: Element) {}
      unobserve() {}
      disconnect() {
        disconnects += 1;
      }
    }
    const globals = globalThis as { ResizeObserver?: unknown };
    const original = globals.ResizeObserver;
    globals.ResizeObserver = FakeResizeObserver;
    try {
      const { api } = createFakeApi();
      const view = renderDocked(api, makeDockNode());
      await settleFrame();
      expect(disconnects).toBe(0);

      view.unmount();
      await settleFrame();

      expect(disconnects).toBeGreaterThan(0);
    } finally {
      globals.ResizeObserver = original;
    }
  });
});
