import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createTab, defaultSession, defaultSettings, type TabState } from "@jslab/shared";
import { act, render, screen } from "@testing-library/react";
import type { MainApi } from "../src/api";
import { WebViewHosts } from "../src/output/WebViewHosts";
import type { WebviewElement } from "../src/output/webview-host";
import { createAppStore } from "../src/state/store";
import { createFakeApi } from "./fake-api";

/**
 * A DEGENERATE dock box -- zero on either axis -- must never become a docked rect.
 *
 * Measured on a live run at two window sizes, twice: the docked tile and the native `<electrobun-webview>` surface
 * agreed exactly, at `x=48 y=522.296875 w=1352 h=0`, with the width tracking the window (1352 -> 1652) while the
 * height stayed 0. So `WebViewTile` measures faithfully and the native layer receives precisely what JSLab ships --
 * and what JSLab shipped was a zero-height frame.
 *
 * Why that is not merely useless but harmful is recorded on `COLLAPSED_STYLE` in `WebViewTile.tsx`: the devkit's
 * `OverlaySyncController.sync()` early-returns on `newRect.width === 0 && newRect.height === 0`. That is an
 * **AND**, so it suppresses only an exact 0x0 -- a 1352x0 sails straight through to the compositor, while a tile
 * that collapses to exactly 0x0 is never synced at all and the surface stays painted at its last docked rect, on
 * top of the HTML the collapse was supposed to make room for. Both halves are fixed the same way: a box with no
 * area is treated as not-docked and renders `COLLAPSED_STYLE`, whose 1x1 deliberately clears the devkit guard.
 *
 * **What this file can prove.** happy-dom lays nothing out, so the boxes here are assigned explicitly (the
 * `setBox` pattern from `widget-occlusion.test.ts`; `output-tiles.test.tsx` spies on the same prototype method).
 * That makes geometry assertable here in a way `webview-tile-tracking.test.tsx` deliberately avoids -- it is the
 * dock's *reported* box that drives the tile's inline style, and that reporting is what is faked. The positive
 * controls are what stop this passing for the wrong reason: a mutant that simply never docks would satisfy the
 * degenerate cases and fail the healthy one.
 */

function tabWith(id: string): TabState {
  return createTab({
    id,
    runtime: "browser",
    layout: {
      orientation: "vertical",
      editorSize: 45,
      outputVisible: true,
      tiles: { webviewVisible: true, consoleSize: 55 },
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

type RectLike = { top: number; left: number; right: number; bottom: number; width: number; height: number };

/** happy-dom lays nothing out -- every `getBoundingClientRect` is 0x0 -- so boxes are assigned explicitly. */
const boxes = new WeakMap<Element, RectLike>();
function setBox(element: Element, box: { top: number; left: number; width: number; height: number }): void {
  boxes.set(element, {
    top: box.top,
    left: box.left,
    width: box.width,
    height: box.height,
    right: box.left + box.width,
    bottom: box.top + box.height,
  });
}
const ZERO: RectLike = { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };

let originalRect: PropertyDescriptor | undefined;
beforeEach(() => {
  originalRect = Object.getOwnPropertyDescriptor(Element.prototype, "getBoundingClientRect");
  Object.defineProperty(Element.prototype, "getBoundingClientRect", {
    configurable: true,
    value(this: Element) {
      return boxes.get(this) ?? ZERO;
    },
  });
});
afterEach(() => {
  if (originalRect) Object.defineProperty(Element.prototype, "getBoundingClientRect", originalRect);
});

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

/** Lets a coalesced (`requestAnimationFrame`-deferred) re-measure run, and flushes any React update it produces. */
async function settleFrame(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
}

/**
 * Drives a re-measure the way the app does: a structural DOM change, which `WebViewTile`'s `MutationObserver` on
 * `body` turns into a scheduled measurement. Used for the transition cases, where the box changes after mount.
 */
async function remeasure(): Promise<void> {
  const row = document.createElement("div");
  document.body.appendChild(row);
  await settleFrame();
  row.remove();
  await settleFrame();
}

const tile = () => screen.getByTestId("webview-tile-t1");

describe("a docked tile never commits a degenerate dock box as its rect", () => {
  /**
   * The measured defect, exactly: the live run's own numbers. Without the guard the tile commits the box verbatim
   * and renders `height: 0px` with a real width -- the 1352x0 frame that clears the devkit's 0x0-only early return
   * and reaches the compositor.
   */
  test("a dock with zero height renders the collapsed 1x1, not a height-0 fixed rect", async () => {
    const { api } = createFakeApi();
    const dockNode = makeDockNode();
    setBox(dockNode, { top: 522.296875, left: 48, width: 1352, height: 0 });
    renderDocked(api, dockNode);
    await settleFrame();

    expect(tile().style.width).toBe("1px");
    expect(tile().style.height).toBe("1px");
    expect(tile().style.top).toBe("0px");
    expect(tile().style.left).toBe("0px");
  });

  /** The other axis. A guard written `box.height <= 0` alone would pass the case above and fail here. */
  test("a dock with zero width renders the collapsed 1x1", async () => {
    const { api } = createFakeApi();
    const dockNode = makeDockNode();
    setBox(dockNode, { top: 522, left: 48, width: 0, height: 600 });
    renderDocked(api, dockNode);
    await settleFrame();

    expect(tile().style.width).toBe("1px");
    expect(tile().style.height).toBe("1px");
  });

  /**
   * The positive control, and the reason the assertions above mean what they claim: a healthy dock still docks.
   * A mutant that collapsed unconditionally -- or never committed a rect at all -- would pass both cases above and
   * die here.
   */
  test("a dock with a real box still commits it verbatim", async () => {
    const { api } = createFakeApi();
    const dockNode = makeDockNode();
    setBox(dockNode, { top: 522.296875, left: 48, width: 1352, height: 286 });
    renderDocked(api, dockNode);
    await settleFrame();

    expect(tile().style.top).toBe("522.296875px");
    expect(tile().style.left).toBe("48px");
    expect(tile().style.width).toBe("1352px");
    expect(tile().style.height).toBe("286px");
  });

  /**
   * The user-reported shape: a tile that HAD a real docked rect and then loses its height (a pane relaying out, the
   * console starving the preview) must give the surface a valid box to shrink to. Without the guard the tile keeps
   * a real width and goes to `height: 0px`; the surface is then a zero-height frame at the old coordinates.
   */
  test("a docked tile that later loses its height collapses instead of going to height 0", async () => {
    const { api } = createFakeApi();
    const dockNode = makeDockNode();
    setBox(dockNode, { top: 522.296875, left: 48, width: 1352, height: 286 });
    renderDocked(api, dockNode);
    await settleFrame();
    expect(tile().style.height).toBe("286px");

    setBox(dockNode, { top: 522.296875, left: 48, width: 1352, height: 0 });
    await remeasure();

    expect(tile().style.width).toBe("1px");
    expect(tile().style.height).toBe("1px");
  });

  /** ...and recovers: a dock that regains a real box docks again, so the collapse is not a one-way latch. */
  test("a dock that regains a real box docks again", async () => {
    const { api } = createFakeApi();
    const dockNode = makeDockNode();
    setBox(dockNode, { top: 522, left: 48, width: 1352, height: 0 });
    renderDocked(api, dockNode);
    await settleFrame();
    expect(tile().style.height).toBe("1px");

    setBox(dockNode, { top: 480, left: 48, width: 1352, height: 320 });
    await remeasure();

    expect(tile().style.top).toBe("480px");
    expect(tile().style.width).toBe("1352px");
    expect(tile().style.height).toBe("320px");
  });
});
