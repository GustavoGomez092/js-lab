import { deriveTitle } from "@jslab/shared";
import { useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { getEditorHandle } from "../editor/editor-handle";
import { useOverlayPresence } from "../shell/overlay-presence";
import type { AppStore } from "../state/store";
import { strings } from "../strings";

export function RenameDialog({ store }: { store: AppStore }) {
  const modal = useStore(store, (s) => s.modal);
  if (modal?.kind !== "rename") return null;
  return <RenameForm key={modal.tabId} store={store} tabId={modal.tabId} />;
}

function RenameForm({ store, tabId }: { store: AppStore; tabId: string }) {
  // M4 T9c: this component only ever mounts while the rename dialog is open (`RenameDialog` above returns null
  // otherwise), so its whole mount lifetime IS the open window -- see `overlay-presence.ts`.
  useOverlayPresence(true);
  const tab = store.getState().tabs[tabId];
  const [value, setValue] = useState(() =>
    tab ? deriveTitle(tab, store.getState().buffers[tabId] ?? "", strings.tabs.untitled) : "",
  );
  // m-1: whatever had focus when the dialog opened (a tab, a menu item, ...) gets it back on close, so
  // rename/close/cancel never strands focus on the (now unmounted) dialog.
  const opener = useRef(document.activeElement);
  useEffect(() => {
    return () => {
      const previous = opener.current;
      if (previous instanceof HTMLElement && document.contains(previous)) previous.focus();
      else getEditorHandle()?.focus();
    };
  }, []);
  if (!tab) return null;
  const close = () => store.getState().closeModal();
  return (
    <div className="dialog-backdrop">
      <form
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rename-title"
        onSubmit={(event) => {
          event.preventDefault();
          store.getState().renameTab(tabId, value);
          close();
        }}
      >
        <h2 id="rename-title">{strings.tabs.renameTitle}</h2>
        <input
          className="dialog-input"
          aria-label={strings.tabs.renameLabel}
          // biome-ignore lint/a11y/noAutofocus: the dialog exists only to edit this field
          autoFocus
          onFocus={(event) => event.currentTarget.select()}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              close();
            }
          }}
        />
        <p>{strings.tabs.renameHelp}</p>
        <div className="dialog-actions">
          <button type="button" onClick={close}>
            {strings.tabs.cancel}
          </button>
          <button type="submit" className="primary">
            {strings.tabs.save}
          </button>
        </div>
      </form>
    </div>
  );
}
