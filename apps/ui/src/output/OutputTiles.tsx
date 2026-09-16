import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import { useStore } from "zustand";
import type { MainApi } from "../api";
import { SplitPane } from "../shell/SplitPane";
import type { AppStore } from "../state/store";
import { OutputPanel } from "./OutputPanel";
import type { WebviewDock } from "./WebViewHosts";

/**
 * Tile arrangement (Task 8, spec §7.1 / Appendix C): the Console tile (`OutputPanel`) and the Web View tile,
 * stacked or side by side, per tab. Reuses `SplitPane` nested inside the Editor/Output split's own `second` slot
 * (`apps/ui/src/shell/App.tsx`) -- `SplitPane` renders exactly two panes, so a third tile is this nested instance,
 * not a change to that component (see `task-8-asbuilt.md` §1).
 *
 * Fix round 1 (F1/F2): this component no longer owns the tab's `<electrobun-webview>` -- that lives permanently
 * in `WebViewHosts`, a sibling of the *outer* Editor/Output split, so it survives both hiding the Output panel and
 * switching tabs. This component only ever owns an empty placeholder `<div>` -- the real webview's *docking*
 * target -- reported upward via `onWebviewDock` whenever it exists. Because the split (and its placeholder) is
 * rendered **only** when the Web View is actually meant to be visible, `SplitPane`'s own hide-on-`false` path
 * (dropping `second` and its divider) is exactly what should happen here: there is nothing dishonest left to gate
 * (fix round 1, F4) -- a hidden Web View simply has no split, the same shape as a `bun` tab's console-only render.
 */
export function OutputTiles({
  store,
  api,
  runKeys = null,
  onInstall,
  onWebviewDock,
}: {
  store: AppStore;
  api: MainApi;
  /** The Run keycap from the effective keybindings, for the Console tile's empty state. */
  runKeys?: string | null;
  onInstall?(spec: string): void;
  /** Fix round 1 (F1/F2): which DOM node the active tab's webview should currently portal into, or `null` when
   * there isn't one right now. `WebViewHosts` (a sibling, not a descendant, of this component) is the consumer. */
  onWebviewDock(dock: WebviewDock | null): void;
}) {
  const tabId = useStore(store, (s) => s.tab?.id ?? null);
  const runtime = useStore(store, (s) => s.tab?.runtime);
  const tiles = useStore(store, (s) => s.tab?.layout.tiles);
  // spec §7.1: unavailable for `bun` -- no Web View tile, and no `<electrobun-webview>` DOM node, ever, for a
  // `bun` tab (StatusBar's toggle mirrors this with its own disabled state).
  const webviewSupported = runtime !== undefined && runtime !== "bun";
  const showSplit = webviewSupported && Boolean(tiles?.webviewVisible);

  const dockRef = useRef<HTMLDivElement | null>(null);
  // Reports the placeholder up whenever there is one to report, and unconditionally clears it on cleanup -- which
  // fires both on every dependency change (a tab switch, a visibility toggle) and on unmount (Output hidden, or
  // this whole component leaving the tree for any other reason). `WebViewHosts` parks the tab the moment this
  // fires null; it never removes the tab's element merely because nobody is currently docking it.
  useEffect(() => {
    if (showSplit && tabId && dockRef.current) onWebviewDock({ tabId, node: dockRef.current });
    return () => onWebviewDock(null);
  }, [showSplit, tabId, onWebviewDock]);

  const consoleTile = <OutputPanel store={store} api={api} runKeys={runKeys} onInstall={onInstall} />;

  if (!showSplit || !tiles) return consoleTile;

  const panes: Record<"console" | "webview", ReactNode> = {
    console: consoleTile,
    webview: <div className="webview-tile-dock" ref={dockRef} />,
  };
  // The schema (`tabTilesSchema`, packages/shared) refines `order` to always list both kinds exactly once, but
  // that guarantee isn't visible to TypeScript's plain-array type -- these defaults are unreachable in practice.
  const [firstKind = "console", secondKind = "webview"] = tiles.order;
  const orientation = tiles.arrangement === "side-by-side" ? "horizontal" : "vertical";
  // `consoleSize` always names the Console pane's own share, regardless of which side it renders on; SplitPane's
  // `size` always applies to `first`, so convert when Console is `second` (task-8-asbuilt.md §1).
  const consoleShare = tiles.consoleSize;
  const size = firstKind === "console" ? consoleShare : 100 - consoleShare;

  return (
    <SplitPane
      orientation={orientation}
      size={size}
      // Unconditionally true here -- reached only when `showSplit` already established both panes belong on
      // screen, so there is nothing left to hide at this level (fix round 1, F4).
      secondVisible
      onResize={(next) => {
        const consoleSize = firstKind === "console" ? next : 100 - next;
        store.getState().setConsoleSize(consoleSize);
      }}
      onReset={() => store.getState().resetConsoleSize()}
      first={panes[firstKind]}
      second={panes[secondKind]}
    />
  );
}
