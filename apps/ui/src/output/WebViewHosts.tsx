import { useState } from "react";
import { useStore } from "zustand";
import type { AppStore } from "../state/store";
import { WebViewTile } from "./WebViewTile";

/** Which DOM node -- and which tab -- `OutputTiles`'s real docking placeholder currently is, or `null` when no
 * tab has one right now (Output hidden, the active tab is `bun`, or its own Web View toggle is off). */
export interface WebviewDock {
  tabId: string;
  node: HTMLDivElement;
}

/**
 * Owns one persistent `<electrobun-webview>` host per open tab whose runtime supports one -- fix round 1's answer
 * to F1 ("two ordinary user actions ... still unmount it") and F2 ("one `WebViewTile` serves every tab").
 *
 * Rendered once, directly under `<App>`, as a **sibling** of the Editor/Output `SplitPane` -- never inside it, and
 * never inside `OutputTiles`. `apps/ui/src/shell/App.tsx`'s outer `SplitPane` still unmounts `OutputTiles` exactly
 * as before when `outputVisible` goes false (`SplitPane.tsx:56-62`), and `OutputTiles` still returns early for a
 * `bun` tab -- but by the time either happens, this component and every `WebViewTile` it owns are elsewhere.
 *
 * Every tab whose runtime isn't `bun` gets a `WebViewTile`, keyed by `tabId` so React never remounts it across a
 * tab switch. Each one **always** portals into this component's own permanent `parkingNode` (see
 * `WebViewTile.tsx`'s doc comment for why: portaling into `OutputTiles`'s own placeholder instead was fix round
 * 1's first attempt, and it failed -- that placeholder is a DOM child of a component that is allowed to unmount,
 * and removing a DOM node destroys everything physically nested inside it, portaled content included). The tab
 * named by `dock.tabId` gets `dockNode={dock.node}` and `docked` so it visually tracks that placeholder's box;
 * every other tab gets `dockNode={null}`, `docked={false}` and collapses instead of unmounting.
 */
export function WebViewHosts({ store, dock }: { store: AppStore; dock: WebviewDock | null }) {
  // A primitive (a string), not `s.tabs` itself -- `s.tabs` is a new object reference on every single tab update,
  // including a viewState-only commit, and this component would re-render on each one otherwise (isolated/app.
  // test.tsx's "a view-state commit doesn't re-render the shell" guards exactly this class of regression). This
  // string is `Object.is`-stable across any change that doesn't add/remove a web-capable tab or flip a tab's own
  // runtime to or from `bun`.
  const webTabsKey = useStore(store, (s) =>
    s.tabOrder
      .filter((id) => {
        const runtime = s.tabs[id]?.runtime;
        return runtime !== undefined && runtime !== "bun";
      })
      .join(","),
  );
  const [parkingNode, setParkingNode] = useState<HTMLDivElement | null>(null);

  const webTabs = webTabsKey ? webTabsKey.split(",") : [];

  return (
    <>
      {/* Always mounted; every tab's element lives here, positioned via its own `position: fixed` (see
          WebViewTile.tsx) rather than DOM nesting -- so nothing here is ever a portal target that can vanish out
          from under a webview. Fix round 2 (N2): deliberately NOT `aria-hidden` -- that attribute on an ancestor
          removes the *whole* subtree from the accessibility tree, and a descendant's `aria-hidden="false"` cannot
          re-expose it. That would make the one tile that's actually on screen permanently unreachable to
          assistive technology. Exposure is each `WebViewTile`'s own job (its `aria-hidden={!docked}`), which only
          works because nothing above it says otherwise. */}
      <div ref={setParkingNode} className="webview-parking" />
      {parkingNode &&
        webTabs.map((tabId) => {
          const docked = dock?.tabId === tabId;
          return (
            <WebViewTile
              key={tabId}
              tabId={tabId}
              dockNode={docked ? (dock?.node ?? null) : null}
              docked={docked}
              parkingNode={parkingNode}
            />
          );
        })}
    </>
  );
}
