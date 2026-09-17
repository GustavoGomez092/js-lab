import type { TabState } from "@jslab/shared";
import type { MainApi } from "../api";

/**
 * The `tab.patch` body App.tsx's store-subscribe diff sends whenever a tab's language, runtime, layout or title
 * fields change -- `null` when nothing tracked here changed. Its own module (not inlined in App.tsx, which pulls
 * in the Editor/Monaco import graph) so a test can import it directly and prove a `layout.tiles` change survives
 * the trip through the real `tabPatchSchema` (`@jslab/rpc-schema`) Main validates every `tab.patch` against
 * (ruling R-M4-T8-PATCH-1) -- a test that stopped at the store would pass even if `tiles` were silently stripped
 * in transit.
 */
export function computeTabPatch(before: TabState, next: TabState): Parameters<MainApi["patchTab"]>[1] | null {
  // updateLayout (state/store.ts) always replaces the layout object, even when the clamped fields end up the same
  // (a divider drag past 10/90, or a reset to the current split), so compare fields rather than the object
  // reference (fix round 1, I-1).
  const layoutChanged =
    next.layout.orientation !== before.layout.orientation ||
    next.layout.editorSize !== before.layout.editorSize ||
    next.layout.outputVisible !== before.layout.outputVisible ||
    next.layout.tiles.arrangement !== before.layout.tiles.arrangement ||
    next.layout.tiles.webviewVisible !== before.layout.tiles.webviewVisible ||
    next.layout.tiles.consoleSize !== before.layout.tiles.consoleSize ||
    next.layout.tiles.order.join(",") !== before.layout.tiles.order.join(",") ||
    next.layout.muted !== before.layout.muted;
  if (
    next.language === before.language &&
    next.runtime === before.runtime &&
    !layoutChanged &&
    next.title === before.title &&
    next.titleIsCustom === before.titleIsCustom
  ) {
    return null;
  }
  return {
    language: next.language,
    runtime: next.runtime,
    layout: next.layout,
    title: next.title,
    titleIsCustom: next.titleIsCustom,
  };
}
