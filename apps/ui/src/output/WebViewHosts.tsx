import { useEffect, useState } from "react";
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
 * Every tab whose runtime isn't `bun` gets a `WebViewTile`, mounted as soon as it opens (or as soon as its runtime
 * becomes web-capable) -- in tab order, matching Task 8's original approach -- and keyed by `tabId` so React never
 * remounts it across a tab switch. **What Task 9's N4 makes lazy is the expensive native webview inside each tile,
 * not the lightweight tile wrapper itself** (see `WebViewTile.tsx`'s own doc comment for why mounting the wrapper
 * eagerly, while still deferring the real `<electrobun-webview>`, is the correct split -- deferring the wrapper's
 * own mount instead, an earlier version of this fix, broke DOM sibling order because these wrappers are portals).
 * `everEnabled` below tracks which tabIds have had their own Web View toggle switched on at least once, and is
 * passed down as each tile's `enabled` prop; it is otherwise unrelated to which tiles exist. Each tile **always**
 * portals into this component's own permanent `parkingNode` (see `WebViewTile.tsx`'s doc comment for why: portaling
 * into `OutputTiles`'s own placeholder instead was fix round 1's first attempt, and it failed -- that placeholder
 * is a DOM child of a component that is allowed to unmount, and removing a DOM node destroys everything physically
 * nested inside it, portaled content included). The tab named by `dock.tabId` gets `dockNode={dock.node}` and
 * `docked` so it visually tracks that placeholder's box; every other tab gets `dockNode={null}`, `docked={false}`
 * and collapses instead of unmounting.
 */
export function WebViewHosts({ store, dock }: { store: AppStore; dock: WebviewDock | null }) {
  // Every currently open, web-capable tab, paired with whether its own Web View toggle is on right now -- a
  // primitive string, `Object.is`-stable across a change that doesn't touch a web-capable tab's identity, runtime
  // or toggle (same discipline the old `webTabsKey` kept; see isolated/app.test.tsx's "a view-state commit
  // doesn't re-render the shell"). Tab ids are `crypto.randomUUID()` (store.ts), so they never contain "=".
  // Also this component's `webTabs` render list directly: every web-capable tab mounts a tile, in this order --
  // tab order -- regardless of whether it has ever been enabled (see the doc comment above for why).
  const liveKey = useStore(store, (s) =>
    s.tabOrder
      .map((id) => {
        const tab = s.tabs[id];
        if (!tab || tab.runtime === "bun") return null;
        return `${id}=${tab.layout.tiles.webviewVisible ? "1" : "0"}`;
      })
      .filter((entry): entry is string => entry !== null)
      .join(","),
  );
  const [parkingNode, setParkingNode] = useState<HTMLDivElement | null>(null);
  const webTabs = liveKey ? liveKey.split(",").map((entry) => entry.split("=")[0] as string) : [];

  // N4: which tabIds have ever had their Web View toggle on -- passed to each tile as `enabled`, gating creation
  // of the real `<electrobun-webview>` inside it (`WebViewTile.tsx`). Once added here a tabId is never removed
  // while its tab stays open -- even if the toggle goes back off -- which is what makes creation a one-way,
  // "first enable" event rather than something a later disable could undo (the Task 8 never-unmount invariant
  // this must not weaken). A tabId is only ever dropped when the tab itself closes (or its runtime becomes `bun`,
  // which removes Web View capability entirely and unmounts its tile -- the same case Task 8's own filter already
  // excluded -- so a tab switched back to a web-capable runtime later gets a genuinely fresh tile and host).
  const [everEnabled, setEverEnabled] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    const entries = liveKey ? liveKey.split(",") : [];
    const openIds = new Set(entries.map((entry) => entry.split("=")[0]));
    setEverEnabled((previous) => {
      let changed = false;
      const next = new Set<string>();
      for (const id of previous) {
        if (openIds.has(id)) next.add(id);
        else changed = true; // the tab closed, or lost web capability: drop it (its tile is unmounting too)
      }
      for (const entry of entries) {
        const [id, on] = entry.split("=");
        if (on === "1" && id !== undefined && !next.has(id)) {
          next.add(id);
          changed = true;
        }
      }
      return changed ? next : previous;
    });
  }, [liveKey]);

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
              enabled={everEnabled.has(tabId)}
            />
          );
        })}
    </>
  );
}
