import type { ReactNode } from "react";
import { useStore } from "zustand";
import type { MainApi } from "../api";
import { SplitPane } from "../shell/SplitPane";
import type { AppStore } from "../state/store";
import { OutputPanel } from "./OutputPanel";
import { WebViewTile } from "./WebViewTile";

/**
 * Tile arrangement (Task 8, spec §7.1 / Appendix C): the Console tile (`OutputPanel`) and the Web View tile,
 * stacked or side by side, per tab. Reuses `SplitPane` nested inside the Editor/Output split's own `second` slot
 * (`apps/ui/src/shell/App.tsx`) -- `SplitPane` renders exactly two panes, so a third tile is this nested instance,
 * not a change to that component (see `task-8-asbuilt.md` §1).
 */
export function OutputTiles({
  store,
  api,
  runKeys = null,
  onInstall,
}: {
  store: AppStore;
  api: MainApi;
  /** The Run keycap from the effective keybindings, for the Console tile's empty state. */
  runKeys?: string | null;
  onInstall?(spec: string): void;
}) {
  const runtime = useStore(store, (s) => s.tab?.runtime);
  const tiles = useStore(store, (s) => s.tab?.layout.tiles);
  // spec §7.1: unavailable for `bun` -- no Web View tile, and no `<electrobun-webview>` DOM node, ever, for a
  // `bun` tab (StatusBar's toggle mirrors this with its own disabled state).
  const webviewSupported = runtime !== undefined && runtime !== "bun";

  const consoleTile = <OutputPanel store={store} api={api} runKeys={runKeys} onInstall={onInstall} />;

  if (!webviewSupported || !tiles) return consoleTile;

  const panes: Record<"console" | "webview", ReactNode> = {
    console: consoleTile,
    webview: <WebViewTile visible={tiles.webviewVisible} />,
  };
  // The schema (`tabTilesSchema`, packages/shared) refines `order` to always list both kinds exactly once, but
  // that guarantee isn't visible to TypeScript's plain-array type -- these defaults are unreachable in practice.
  const [firstKind = "console", secondKind = "webview"] = tiles.order;
  const orientation = tiles.arrangement === "side-by-side" ? "horizontal" : "vertical";
  // `consoleSize` always names the Console pane's own share, regardless of which side it renders on; SplitPane's
  // `size` always applies to `first`, so convert when Console is `second` (task-8-asbuilt.md §1).
  const consoleShare = tiles.consoleSize;
  const rawSize = firstKind === "console" ? consoleShare : 100 - consoleShare;
  // Hidden collapses the split's own share too, not just WebViewTile's own box -- belt and suspenders, so no dead
  // space is left where the tile used to be. `consoleSize` itself is untouched, so it's what comes back on show.
  const size = tiles.webviewVisible ? rawSize : firstKind === "console" ? 100 : 0;

  return (
    <SplitPane
      orientation={orientation}
      size={size}
      // Always true: SplitPane's own hide-on-false path would unmount whichever pane isn't `first`, which must
      // never happen to WebViewTile (M0-S4). Visibility is WebViewTile's own job (its `visible` prop above).
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
