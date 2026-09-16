import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * The page every browser-mode tab's `<electrobun-webview>` loads (spec §5.12): a bare, local `views://` page with
 * no external requests -- see `apps/ui/vite.config.ts` and `apps/desktop/electrobun.config.ts` for how
 * `packages/runner-web/index.html` ends up served at this URL.
 */
export const RUNNER_WEB_URL = "views://runner-web/index.html";

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
 * once, at ordinary sequential mount time, and never needs to be re-derived later. (An earlier version of this
 * fix instead delayed *mounting the whole tile* until first enable and derived its render order from tab order at
 * every render; that doesn't actually reorder the DOM, because these tiles are portals into a shared container --
 * React's reconciler does not move an already-mounted portal's node relative to a sibling portal's node just
 * because the JS array feeding `.map()` changed order, since portal placement isn't tracked through the normal
 * host-sibling machinery that ordinary (non-portal) keyed children get. Verified empirically: reordering the
 * array after two portals had already mounted separately left the DOM order exactly as first mounted.) What stays
 * genuinely lazy is the **expensive** part: the real `<electrobun-webview>` element inside this cheap wrapper div
 * is created only once `enabled` becomes true (mirrors `WebViewHosts`'s `everEnabled`: the tab's own Web View
 * toggle has been switched on at least once), and, once created, is never removed while this component stays
 * mounted -- `created` below is a ref, not state, specifically so a later `enabled: false` (which the invariant
 * says should never happen while mounted, but this guards it anyway) can never re-trigger or undo the creation.
 */
export function WebViewTile({
  tabId,
  dockNode,
  docked,
  parkingNode,
  enabled,
}: {
  tabId: string;
  /** `OutputTiles`'s live docking placeholder to visually track, or `null` when there isn't one right now. */
  dockNode: HTMLElement | null;
  docked: boolean;
  /** `WebViewHosts`'s own permanent node: this always portals here, and only ever here. */
  parkingNode: HTMLElement;
  /** Whether the tab's own Web View toggle has ever been switched on. Gates creating the real webview element. */
  enabled: boolean;
}) {
  const container = useRef<HTMLDivElement>(null);
  const created = useRef(false);

  useEffect(() => {
    if (!enabled || created.current) return;
    const host = container.current;
    if (!host) return;
    const webview = document.createElement("electrobun-webview");
    webview.setAttribute("src", RUNNER_WEB_URL);
    webview.className = "webview-tile-surface";
    host.appendChild(webview);
    created.current = true;
    // No cleanup: once created, this element is never removed while the component stays mounted (the never-
    // unmount invariant, at the finer grain `enabled` operates on). The component unmounting entirely -- the tab
    // closes, or loses web capability -- removes this portaled subtree (webview included) the ordinary way,
    // through React's own portal teardown, with no manual `removeChild` needed.
  }, [enabled]);

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
    // jsdom (this package's own tests) has no ResizeObserver; the one measurement above is all a test can see,
    // which is enough to prove docking -- a real browser also tracks the split being dragged or the window resizing.
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
