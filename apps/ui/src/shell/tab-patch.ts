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
    next.layout.tiles.webviewVisible !== before.layout.tiles.webviewVisible ||
    next.layout.tiles.consoleSize !== before.layout.tiles.consoleSize ||
    next.layout.muted !== before.layout.muted;
  const titleChanged = next.title !== before.title || next.titleIsCustom !== before.titleIsCustom;
  if (next.language === before.language && next.runtime === before.runtime && !layoutChanged && !titleChanged) {
    return null;
  }
  return {
    language: next.language,
    runtime: next.runtime,
    layout: next.layout,
    // M5c F3: the title goes out ONLY when it changed here. Sending it on every tracked change meant one unrelated
    // edit (a single divider drag) pushed this store's title back to Main, silently REVERTING a rename Main had made
    // on its own -- `jslab --title` on an already-open file, whose `file.opened` carries no entry for that tab.
    // `tabPatchSchema.patch` is `.partial()`, so an omitted title leaves Main's own alone.
    ...(titleChanged ? { title: next.title, titleIsCustom: next.titleIsCustom } : {}),
  };
}
