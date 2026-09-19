import type { ReactNode } from "react";
import { useCallback } from "react";
import { useStore } from "zustand";
import type { MainApi } from "../api";
import { SplitPane } from "../shell/SplitPane";
import type { AppStore } from "../state/store";
import { OutputPanel } from "./OutputPanel";
import type { WebviewDock } from "./WebViewHosts";

/**
 * Where the tab's Web View sits relative to the Console (`OutputPanel`), per tab.
 *
 * **R-WEBVIEW-TAB-1 replaced the tile arrangement with two fixed positions.** `tiles.arrangement` and
 * `tiles.order` are gone: the Web View is no longer a peer tile that can be moved around the Console on an axis.
 * It is either the **bottom preview pane** -- a real working area, keeping the draggable `SplitPane` divider,
 * its double-click reset, its arrow keys and `tiles.consoleSize` -- or, when the Web View tab in the filter row
 * is selected, **the entire output panel**, with the log list hidden behind it.
 *
 * Fix round 1 (F1/F2): this component does not own the tab's `<electrobun-webview>` -- that lives permanently in
 * `WebViewHosts`, a sibling of the *outer* Editor/Output split, so it survives both hiding the Output panel and
 * switching tabs. This component only ever owns an empty placeholder `<div>` -- the real webview's *docking*
 * target -- reported upward via `onWebviewDock` whenever it exists.
 *
 * **The invariant that makes the two positions safe: there is exactly ONE dock node, ever.** `WebViewHosts` owns
 * a single `<electrobun-webview>` per tab and points it at whichever node `onWebviewDock` last named; two docks
 * rendered at once would leave it tracking one of them while the other sat blank, with no error anywhere. So the
 * `dock` element below is built once per render and placed in exactly one of the two positions -- the early
 * return for `fullScreen` is what makes "inside `OutputPanel`" and "the split's second pane" mutually exclusive
 * by construction, rather than by two conditions that could both be true.
 *
 * **How the single node MOVES between them** (fix round 2, N1 -- the same mechanism, now reached through the UI
 * rather than only a hand-edited session.json). `onDockRef` is a callback ref, not a `useRef` read inside an
 * effect keyed on unrelated deps. A callback ref fires exactly when the DOM node it is attached to actually
 * changes -- mount, unmount, *or* a remount React performs because the element moved to a different position in
 * the tree. Full screen ↔ preview is precisely that case: the placeholder moves between `OutputPanel`'s body and
 * `SplitPane`'s `second` slot, two different parents, so React unmounts the old node and mounts a new one in the
 * same commit. React detaches refs in the mutation phase and attaches them in the layout phase, so the calls
 * always arrive as `null` then the new node -- never the reverse, and never leaving `WebViewHosts` holding a
 * detached node. The invariant this keeps: **the node `WebViewHosts` is ever told about is always the node
 * currently in the tree**, because this is called on every attach/detach rather than from a dependency list.
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
  const outputView = useStore(store, (s) => s.outputView);
  // spec §7.1: unavailable for `bun` -- no Web View, and no `<electrobun-webview>` DOM node, ever, for a `bun`
  // tab (StatusBar's toggle and the Web View control in the filter row both mirror this).
  const webviewSupported = runtime !== undefined && runtime !== "bun";
  // "The Web View is showing" is one fact, and it is the tab's own toggle -- what `view.toggleWebView`, the View
  // menu, the status bar and the palette all read, and what arms `WebViewHosts`'s lazy element creation.
  const webviewShown = webviewSupported && Boolean(tiles?.webviewVisible);
  // ...and `outputView` decides only how much room it gets. `webviewShown` gates this deliberately: switching to
  // a tab whose Web View is off must show that tab's log list, not a full-screen dock for a webview that was
  // never created for it.
  const fullScreen = webviewShown && outputView === "webview";
  const showSplit = webviewShown && !fullScreen;

  // The node existing IS the condition -- it is rendered only in the two positions where it should be docked, so
  // this deliberately does not re-test `fullScreen`/`showSplit` and cannot disagree with what is in the tree.
  const onDockRef = useCallback(
    (node: HTMLDivElement | null) => {
      if (node && tabId) onWebviewDock({ tabId, node });
      else onWebviewDock(null);
    },
    [tabId, onWebviewDock],
  );

  // Built once, placed once (see this component's doc comment). `className` differs between the two positions
  // because the CSS must: a class change re-styles the node, it never remounts it.
  const dock: ReactNode = (
    <div className={`webview-tile-dock${fullScreen ? " webview-tile-dock-full" : ""}`} ref={onDockRef} />
  );

  const consoleTile = (
    <OutputPanel
      store={store}
      api={api}
      runKeys={runKeys}
      onInstall={onInstall}
      webviewSupported={webviewSupported}
      webViewSlot={fullScreen ? dock : null}
    />
  );

  // Full screen: the dock is already inside `consoleTile`, in place of the log list. Not shown at all: no dock
  // anywhere, the same console-only shape a `bun` tab renders. Either way there is no split and nothing to hide,
  // so `SplitPane`'s own hide-on-`false` path never has to be asked for (fix round 1, F4).
  if (fullScreen || !showSplit || !tiles) return consoleTile;

  // The preview: Console above, Web View below. With `order` retired the Console is always `first`, so
  // `consoleSize` is the size `SplitPane` wants directly -- the old conversion for "Console is second" is gone
  // along with the field that could put it there.
  return (
    <SplitPane
      orientation="vertical"
      size={tiles.consoleSize}
      // Unconditionally true here -- reached only when `showSplit` already established both panes belong on
      // screen, so there is nothing left to hide at this level (fix round 1, F4).
      secondVisible
      onResize={(next) => store.getState().setConsoleSize(next)}
      onReset={() => store.getState().resetConsoleSize()}
      first={consoleTile}
      second={dock}
    />
  );
}
