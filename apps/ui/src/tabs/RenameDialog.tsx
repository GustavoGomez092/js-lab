import { deriveTitle } from "@jslab/shared";
import { useState } from "react";
import { useStore } from "zustand";
import type { AppStore } from "../state/store";
import { strings } from "../strings";

export function RenameDialog({ store }: { store: AppStore }) {
  const modal = useStore(store, (s) => s.modal);
  if (modal?.kind !== "rename") return null;
  return <RenameForm key={modal.tabId} store={store} tabId={modal.tabId} />;
}

function RenameForm({ store, tabId }: { store: AppStore; tabId: string }) {
  const tab = store.getState().tabs[tabId];
  const [value, setValue] = useState(() => (tab ? deriveTitle(tab, store.getState().buffers[tabId] ?? "") : ""));
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
