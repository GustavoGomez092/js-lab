import { deriveTitle, isDirty } from "@jslab/shared";
import { useCallback, useState } from "react";
import { useStore } from "zustand";
import type { MainApi } from "../api";
import type { AppStore } from "../state/store";
import { strings } from "../strings";
import { ContextMenu, type MenuEntry } from "./ContextMenu";
import { reorderByDrop } from "./reorder";
import type { TabActions } from "./tab-actions";

const DRAG_TYPE = "application/x-jslab-tab";

export function TabBar(props: {
  store: AppStore;
  tabs: TabActions;
  api: Pick<MainApi, "revealInFinder" | "copyPath">;
}) {
  const { store, tabs, api } = props;
  const order = useStore(store, (s) => s.tabOrder);
  const byId = useStore(store, (s) => s.tabs);
  const buffers = useStore(store, (s) => s.buffers);
  const activeId = useStore(store, (s) => s.activeTabId);
  const [menu, setMenu] = useState<{ tabId: string; x: number; y: number } | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; after: boolean } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);

  const menuItems = (tabId: string): MenuEntry[] => {
    const tab = byId[tabId];
    const index = order.indexOf(tabId);
    return [
      { id: "rename", label: strings.tabs.rename, run: () => store.getState().openModal({ kind: "rename", tabId }) },
      { id: "close", label: strings.tabs.closeOne, run: () => void tabs.close(tabId) },
      {
        id: "others",
        label: strings.tabs.closeOthers,
        disabled: order.length < 2,
        run: () => void tabs.closeOthers(tabId),
      },
      {
        id: "right",
        label: strings.tabs.closeToRight,
        disabled: index === order.length - 1,
        run: () => void tabs.closeToRight(tabId),
      },
      { id: "reveal", label: strings.tabs.reveal, disabled: !tab?.filePath, run: () => api.revealInFinder(tabId) },
      { id: "copy", label: strings.tabs.copyPath, disabled: !tab?.filePath, run: () => api.copyPath(tabId) },
    ];
  };

  return (
    <div className="tab-bar electrobun-webkit-app-region-no-drag" role="tablist" aria-label={strings.tabs.list}>
      {order.map((id) => {
        const tab = byId[id];
        if (!tab) return null;
        const code = buffers[id] ?? "";
        const title = deriveTitle(tab, code);
        const active = id === activeId;
        const dirty = isDirty(tab, code);
        const dropClass = dropTarget?.id === id ? (dropTarget.after ? " drop-after" : " drop-before") : "";
        return (
          <div
            key={id}
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            className={`tab${active ? " on" : ""}${dropClass}`}
            title={tab.filePath ?? title}
            draggable
            onClick={() => tabs.activate(id)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") tabs.activate(id);
            }}
            onMouseDown={(event) => {
              if (event.button === 1) event.preventDefault();
            }}
            onAuxClick={(event) => {
              if (event.button !== 1) return;
              event.preventDefault();
              void tabs.close(id);
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              setMenu({ tabId: id, x: event.clientX, y: event.clientY });
            }}
            onDragStart={(event) => {
              event.dataTransfer.setData(DRAG_TYPE, id);
              event.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={(event) => {
              if (!event.dataTransfer.types.includes(DRAG_TYPE)) return;
              event.preventDefault();
              const rect = event.currentTarget.getBoundingClientRect();
              setDropTarget({ id, after: event.clientX > rect.left + rect.width / 2 });
            }}
            onDragLeave={() => setDropTarget(null)}
            onDrop={(event) => {
              const dragged = event.dataTransfer.getData(DRAG_TYPE);
              const after = dropTarget?.id === id ? dropTarget.after : false;
              setDropTarget(null);
              if (!dragged) return;
              event.preventDefault();
              tabs.reorder(reorderByDrop(store.getState().tabOrder, dragged, id, after));
            }}
          >
            {dirty && <span className="tab-dirty" role="img" aria-label={strings.tabs.unsaved} />}
            <span className="tab-title">{title}</span>
            <button
              type="button"
              className="tab-close"
              aria-label={strings.tabs.close(title)}
              onClick={(event) => {
                event.stopPropagation();
                void tabs.close(id);
              }}
            >
              ×
            </button>
          </div>
        );
      })}
      <button type="button" className="tab-new" aria-label={strings.tabs.newTab} onClick={() => void tabs.newTab()}>
        +
      </button>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.tabId)} onClose={closeMenu} />}
    </div>
  );
}
