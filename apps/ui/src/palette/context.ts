import type { AppState } from "../state/store";

/**
 * Which context the command palette opens in (Task 20).
 *
 * Fix round 1 (m-5): `store.focus` is only updated by explicit focus-capture handlers (OutputPanel, Monaco) and is
 * never reset when focus moves elsewhere (toolbar, tab bar, side bar, blur to body), so it can go stale. The live
 * DOM focus -- the same signal `contextFromState` uses for `outputFocus` -- is the source of truth; `store.focus`
 * is only the fallback for when nothing meaningful has focus at all.
 *
 * Extracted from App.tsx so the focus commands (UI item 2) can be pinned against the very function the shell uses:
 * those commands exist to make this context something a keyboard user chooses rather than inherits from wherever
 * they last clicked.
 */
export function paletteContext(active: Element | null, storeFocus: AppState["focus"]): "editor" | "output" {
  if (active && active !== document.body) return active.closest(".output") ? "output" : "editor";
  return storeFocus === "output" ? "output" : "editor";
}
