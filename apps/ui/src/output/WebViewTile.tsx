import { useEffect, useRef } from "react";

/**
 * The page every browser-mode tab's `<electrobun-webview>` loads (spec §5.12): a bare, local `views://` page with
 * no external requests -- see `apps/ui/vite.config.ts` and `apps/desktop/electrobun.config.ts` for how
 * `packages/runner-web/index.html` ends up served at this URL.
 */
export const RUNNER_WEB_URL = "views://runner-web/index.html";

/**
 * The Web View tile (Task 8, spec §7.1 / Appendix C): hosts one tab's persistent `<electrobun-webview>`.
 *
 * The element is created imperatively, once, in a mount effect with an empty dependency list -- not as JSX --
 * and is never recreated while this component stays mounted. `<electrobun-webview>` is a real, OS-level surface
 * (Electrobun 2.0.1's `webviewtag.ts`, mirrored by `RawWebview` in `apps/desktop/src/main/runtimes/web-adapter.ts`),
 * so tearing it down on every `visible` toggle would reset whatever the running page's timers/rAF were doing --
 * exactly the M0-S4 hazard this component exists to avoid. `visible` therefore only ever changes this component's
 * own CSS (collapsing it to a zero-size box), never whether the element exists.
 *
 * Wiring this element up to Main's `WebviewSource` (so it actually drives a run) is a later task's job -- see the
 * task report for why that wiring waits on a real DOM node existing at all, which is what this component provides.
 */
export function WebViewTile({ visible }: { visible: boolean }) {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = container.current;
    if (!host) return;
    const webview = document.createElement("electrobun-webview");
    webview.setAttribute("src", RUNNER_WEB_URL);
    webview.className = "webview-tile-surface";
    host.appendChild(webview);
    return () => {
      host.removeChild(webview);
    };
  }, []);

  return (
    <div
      className={`webview-tile${visible ? "" : " webview-tile-collapsed"}`}
      data-testid="webview-tile"
      aria-hidden={!visible}
      // Collapse to zero size directly, regardless of whatever share the ancestor SplitPane assigned this pane --
      // never display:none (which a native, compositor-level webview surface may ignore) and never a conditional
      // unmount (see the module doc comment).
      style={visible ? undefined : { width: 0, height: 0, overflow: "hidden", flex: "0 0 0" }}
      ref={container}
    />
  );
}
