import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { WebviewElement } from "./webview-host";

/**
 * The page every browser-mode tab's `<electrobun-webview>` loads (spec §5.12): a bare, local `views://` page with
 * no external requests -- see `apps/ui/vite.config.ts` and `apps/desktop/electrobun.config.ts` for how
 * `packages/runner-web/index.html` ends up served at this URL.
 */
export const RUNNER_WEB_URL = "views://runner-web/index.html";

/** One tab's live webview element: a real DOM node that also answers the Electrobun webview tag's own API. */
export type TileWebview = HTMLElement & WebviewElement;

type Rect = { top: number; left: number; width: number; height: number };

/**
 * One tab's persistent `<electrobun-webview>` host (Task 8, spec §7.1 / Appendix C; fix round 1 F1/F2).
 *
 * Owned and kept alive by `WebViewHosts` for as long as the tab stays open -- `key={tabId}` there is what gives
 * each tab its own instance and prevents this component from ever remounting on a tab switch.
 *
 * **Fix round 1's revised mechanism.** The first attempt at this fix portaled this component's own element
 * directly into `OutputTiles`'s docking placeholder and re-pointed the portal there and back. That is wrong: the
 * placeholder is a DOM child of `OutputTiles`, which *is* allowed to unmount (hiding Output, switching to a `bun`
 * tab) -- and removing a DOM node removes everything physically nested inside it, portaled content included,
 * regardless of which React fiber "owns" it. A test asserting node identity across that action caught it directly
 * (see the report's red/green evidence).
 *
 * So this component's own element **always** portals into `parkingNode` -- `WebViewHosts`'s own permanent,
 * never-unmounting node -- and is **never** re-parented. Instead, when `docked` and `dockNode` are provided (the
 * tab is active, Output is visible, and its own Web View toggle is on), a `ResizeObserver` on `dockNode` -- plus
 * one measurement whenever docking starts -- drives this element's own `position: fixed` coordinates to visually
 * track `dockNode`'s box. `dockNode` is read from, never rendered into. When not docked, this element collapses
 * to a zero-size, non-interactive box instead of being removed.
 *
 * **`enabled` (M4 T9 fix round 1, M2/N4).** `WebViewHosts` mounts one of these for every web-capable tab as soon
 * as it exists -- in tab order, from the very first render -- so DOM sibling order among tiles is established
 * once, at ordinary sequential mount time, and never needs to be re-derived later. What stays genuinely lazy is
 * the **expensive** part: the real `<electrobun-webview>` element inside this cheap wrapper div is created only
 * once `enabled` becomes true.
 *
 * **`generation` (M4 Task 9a).** Task 8's invariant was that the element, once created, is never removed while
 * this component stays mounted. That held while the only thing that could create one was the user's own toggle.
 * It cannot hold now that Main drives the webview as a *runtime*: Kill (and a reset that times out) destroy the
 * webview deliberately and immediately ask for a fresh one (`web-adapter.ts`'s `#killWebview`), and a tab whose
 * element was destroyed but never replaced would fail every later run with a timeout. `generation` is that
 * replacement, made explicit: `WebViewHosts` bumps it only when Main has asked for an element the host registry
 * hasn't got, so the element is still never removed by anything the *user* does -- only by the runtime that owns
 * it, which is the one actor entitled to.
 */
export function WebViewTile({
  tabId,
  dockNode,
  docked,
  parkingNode,
  enabled,
  generation,
  createWebview,
  onElement,
}: {
  tabId: string;
  /** `OutputTiles`'s live docking placeholder to visually track, or `null` when there isn't one right now. */
  dockNode: HTMLElement | null;
  docked: boolean;
  /** `WebViewHosts`'s own permanent node: this always portals here, and only ever here. */
  parkingNode: HTMLElement;
  /** Whether the tab's own Web View toggle has ever been switched on, or Main has asked for a webview. */
  enabled: boolean;
  /** Bumped when Main needs a replacement element; each value creates exactly one webview. */
  generation: number;
  /** Builds the element. Must be referentially stable, or every render would replace the webview. */
  createWebview: () => TileWebview;
  /** Reports this tab's live element (or `null` once it goes away). Must be referentially stable. */
  onElement: (tabId: string, element: TileWebview | null) => void;
}) {
  const container = useRef<HTMLDivElement>(null);

  // `generation` is deliberately a dependency this effect never reads. It is the *reason* the effect re-runs:
  // Main destroying a tab's webview and asking for another (Kill, a timed-out reset) must tear the old element
  // down and build a new one, and a value the body ignores is exactly how that request is expressed. Removing it
  // would leave a killed tab with no webview for good.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above -- `generation` is the re-run trigger.
  useEffect(() => {
    if (!enabled) return;
    const host = container.current;
    if (!host) return;
    const webview = createWebview();
    host.appendChild(webview);
    onElement(tabId, webview);
    return () => {
      // Runs only when `generation` changes (Main asked for a replacement) or this tile unmounts (the tab closed,
      // or stopped being web-capable). Reporting `null` first is what lets the host registry tell those two apart
      // from its own `webRunner.destroy`, which has already removed the element and forgotten the tab by now.
      onElement(tabId, null);
      webview.remove();
    };
  }, [enabled, generation, tabId, createWebview, onElement]);

  const [rect, setRect] = useState<Rect | null>(null);
  useLayoutEffect(() => {
    if (!docked || !dockNode) {
      setRect(null);
      return;
    }
    const measure = () => {
      const box = dockNode.getBoundingClientRect();
      setRect({ top: box.top, left: box.left, width: box.width, height: box.height });
    };
    measure();
    // jsdom/happy-dom (this package's own tests) has no ResizeObserver; the one measurement above is all a test
    // can see, which is enough to prove docking -- a real browser also tracks the split being dragged or the
    // window resizing. That real-run behaviour is verified by hand, not here (see the task report).
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(dockNode);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [docked, dockNode]);

  return createPortal(
    <div
      className="webview-tile"
      data-testid={`webview-tile-${tabId}`}
      aria-hidden={!docked}
      style={
        docked && rect
          ? { position: "fixed", top: rect.top, left: rect.left, width: rect.width, height: rect.height }
          : { position: "fixed", top: 0, left: 0, width: 0, height: 0, overflow: "hidden", pointerEvents: "none" }
      }
      ref={container}
    />,
    parkingNode,
    tabId,
  );
}
