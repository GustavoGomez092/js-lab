import { acquireOverlayPresence } from "../shell/overlay-presence";

/**
 * M4, the user-reported defect: "IntelliSense and console log are behind the DOM render".
 *
 * A native `<electrobun-webview>` surface paints above every HTML element regardless of CSS `z-index` -- see
 * `../shell/overlay-presence.ts`'s header for the live-run evidence. Seven overlays in the shell already dodge that
 * by registering with the presence counter there, which collapses every docked tile while they are open. Monaco's
 * hover, suggest and parameter-hint widgets cannot: they are not React components we render, and (checked against
 * Monaco 0.56's `editor.api.d.ts`) the editor exposes no public "a hover is showing" event to bridge them with --
 * `addContentWidget`/`addOverlayWidget` only cover widgets *we* contribute. That is the architectural hole, not a
 * missing eighth `useOverlayPresence` call.
 *
 * `Editor.tsx` closes it with the one public option that does exist: `overflowWidgetsDomNode`, which makes Monaco
 * put every overflowing widget into a small container we own (Monaco's `view.js` appends both its overflowing
 * content-widget and overlay-widget nodes there). This module watches that container and registers presence with
 * the SAME counter the seven components use.
 *
 * **Why intersection, and not simply "a widget is visible".** The editor sets `fixedOverflowWidgets: true`, so these
 * widgets escape the editor's own box -- but most of the time they land nowhere near the Web View tile. Collapsing
 * the tile for every hover would make a running tab's Web View blink out on virtually every keystroke, which is a
 * worse defect than the one being fixed. So presence is registered only while a widget's box actually overlaps a
 * docked tile's box: exactly the case where the native surface would paint over it, and nothing else.
 */

/** The subset of `DOMRect` this module needs; a real `DOMRect` satisfies it. */
export interface RectLike {
  readonly top: number;
  readonly left: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

/** Half-open overlap on both axes: edge-to-edge contact is not occlusion. */
export function rectsIntersect(a: RectLike, b: RectLike): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

/**
 * The boxes of the native surfaces currently painted -- one per *docked* tile.
 *
 * `WebViewTile` sets `aria-hidden={!docked}`, so `"false"` selects exactly the tiles that are tracking a dock right
 * now. An undocked tile is the 1x1 `COLLAPSED_STYLE` box with nothing meaningful drawn in it, and matching it would
 * make every hover near the viewport origin look occluded.
 */
export function dockedWebviewRects(root: ParentNode = document): RectLike[] {
  return [...root.querySelectorAll('.webview-tile[aria-hidden="false"]')].map((el) => el.getBoundingClientRect());
}

export interface WidgetOcclusionOptions {
  /** The node Monaco was given as `overflowWidgetsDomNode`. */
  container: HTMLElement;
  /** The native surfaces to dodge. Defaults to every docked tile; a seam for tests. */
  occluders?: () => readonly RectLike[];
  /** Registers one occluding surface and returns its release. A seam for tests. */
  acquire?: () => () => void;
  /** A seam for tests; defaults to the global `MutationObserver`. */
  ObserverImpl?: typeof MutationObserver;
}

/**
 * Starts registering overlay presence for as long as a Monaco overflow widget overlaps a docked Web View tile.
 * Returns a disposer that stops watching and releases any presence still held.
 */
export function trackWidgetOcclusion(options: WidgetOcclusionOptions): () => void {
  const { container } = options;
  const occluders = options.occluders ?? (() => dockedWebviewRects());
  const acquire = options.acquire ?? acquireOverlayPresence;
  const ObserverImpl = options.ObserverImpl ?? (typeof MutationObserver === "function" ? MutationObserver : undefined);

  let release: (() => void) | null = null;

  const occluded = (): boolean => {
    const surfaces = occluders();
    // No docked tile means no native surface anywhere, so nothing can be painted over: never collapse.
    if (surfaces.length === 0) return false;
    for (const element of container.querySelectorAll("*")) {
      const rect = element.getBoundingClientRect();
      // Monaco leaves its overflow containers mounted and empty (0x0) between widgets; only a laid-out box counts.
      if (rect.width <= 0 || rect.height <= 0) continue;
      for (const surface of surfaces) {
        if (rectsIntersect(rect, surface)) return true;
      }
    }
    return false;
  };

  const update = (): void => {
    const shouldCollapse = occluded();
    if (shouldCollapse && !release) release = acquire();
    else if (!shouldCollapse && release) {
      release();
      release = null;
    }
  };

  update();

  const stop = (): void => {
    release?.();
    release = null;
  };

  // happy-dom and jsdom both define MutationObserver, but guard anyway: without one this degrades to the single
  // evaluation above rather than throwing, the same way `WebViewTile` degrades without a `ResizeObserver`.
  if (!ObserverImpl) return stop;

  const observer = new ObserverImpl(update);
  // `attributes` matters as much as `childList`: Monaco reuses one hover/suggest node and moves or hides it by
  // rewriting `style`, so a widget can travel onto and off a tile without ever being added or removed.
  observer.observe(container, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["style", "class"],
  });

  return () => {
    observer.disconnect();
    stop();
  };
}
