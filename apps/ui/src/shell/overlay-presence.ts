import { useLayoutEffect, useSyncExternalStore } from "react";

/**
 * M4 T9c: a native `<electrobun-webview>` surface paints above every HTML element regardless of CSS `z-index` --
 * confirmed by a real run (Task 9a's screenshot): with a docked Web View, the command palette's scrim and panel
 * (`.palette-scrim` z-index 70, `.palette` 71) were both visibly occluded by the webview beneath them. CSS stacking
 * simply does not arbitrate a native compositor surface; `z-index` only ever ordered other HTML.
 *
 * The fix is not more `z-index` -- there is no value that wins against a surface `z-index` cannot see at all.
 * Instead, `WebViewHosts` collapses every docked tile (to the same zero-size, `pointerEvents: none` box it already
 * uses while undocked -- see `WebViewTile.tsx`) for as long as at least one overlay is registered here as open, so
 * there is no native surface left in the tile's rectangle for the overlay to lose to. The cost: a running tab's
 * Web View visibly disappears (reverting to whatever is behind it -- the console, or the docking placeholder's own
 * background) for as long as the palette, a dialog, a sheet, or a tab's context menu is open, reappearing the
 * instant it closes. Nothing about the underlying run is affected -- the host is never unmounted (Task 8's
 * invariant) or reset; the tile is merely not drawn on top of anything for that window.
 *
 * This registry is a counter, not `AppStore` state: every overlay in the shell already computes its own "am I
 * open" boolean locally (`modal?.kind === "..."`, or a context menu's own local `useState`), and routing that
 * through the global store for every dialog/sheet/menu would mean touching its schema for a concern that is purely
 * "is something visually on top right now" -- unrelated to anything else in `AppStore`. A future overlay only has
 * to call `useOverlayPresence(open)` to participate; `WebViewHosts` never needs to enumerate them.
 *
 * The counter itself lives on `globalThis`, not as an ordinary module-level `let` -- confirmed necessary by a live
 * run, not a theoretical worry: with a module-level `let`, the command palette correctly collapsed a docked Web
 * View (it and `WebViewHosts` happened to land in the same bundle chunk) while `RenameDialog` did not (Vite's
 * code-splitting had it and `WebViewHosts` pull in two separately-evaluated copies of this module, each with its
 * own `openCount` -- so `RenameForm` incremented a counter `WebViewHosts` never read). A single object keyed on
 * `globalThis` is evaluated once regardless of how many chunks import this file, closing that gap structurally.
 */
const GLOBAL_KEY = "__jslabOverlayPresence__";

interface OverlayPresenceState {
  openCount: number;
  listeners: Set<() => void>;
}

function state(): OverlayPresenceState {
  const g = globalThis as typeof globalThis & { [GLOBAL_KEY]?: OverlayPresenceState };
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = { openCount: 0, listeners: new Set() };
  return g[GLOBAL_KEY];
}

function notify(): void {
  for (const listener of [...state().listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  const s = state();
  s.listeners.add(listener);
  return () => s.listeners.delete(listener);
}

function getSnapshot(): boolean {
  return state().openCount > 0;
}

/** `WebViewHosts` reads this to know whether to collapse every docked tile right now. */
export function useOverlayOpen(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Registers presence of one occluding overlay surface -- a dialog, a sheet, the command palette, or a tab's
 * context menu -- for as long as `open` is true. Safe to call with an `open` that flips over the component's own
 * lifetime (most overlays here are gated by an early `return null`, so the component itself never unmounts) or one
 * that's simply always `true` for a component that only ever mounts while open (the common case -- see each call
 * site's own comment).
 */
export function useOverlayPresence(open: boolean): void {
  /*
   * `useLayoutEffect`, NOT `useEffect` -- and that is a correctness requirement here, not a preference.
   *
   * `useEffect` runs *after* paint. Every consumer of this counter exists to get a native
   * `<electrobun-webview>` surface out of the way (see this module's header), so registering after paint leaves a
   * frame in which the newly mounted overlay is on screen while the native surface is still there to paint over
   * it -- the overlay flickers behind the Web View exactly when it first appears. A layout effect runs before
   * paint, so the tile is already collapsed in the same frame the overlay first draws.
   *
   * This is the same defect family as the 0x0 `OverlaySyncController` guard fixed in Task 9c. It is also the only
   * such race left in this module: `useOverlayOpen` reads through `useSyncExternalStore`, which subscribes during
   * the commit and reads its snapshot synchronously, so it has no after-paint window of its own.
   *
   * The unmount direction is deliberately on the same schedule: releasing the count before paint means the Web
   * View reappears in the frame the overlay leaves, rather than one frame later.
   */
  useLayoutEffect(() => {
    if (!open) return;
    const s = state();
    s.openCount += 1;
    notify();
    return () => {
      s.openCount -= 1;
      notify();
    };
  }, [open]);
}
