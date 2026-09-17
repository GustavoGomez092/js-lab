import type { VsixChoice } from "@jslab/rpc-schema";
import { useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { getEditorHandle } from "../editor/editor-handle";
import { useOverlayPresence } from "../shell/overlay-presence";
import type { AppStore } from "../state/store";
import { strings } from "../strings";
import { applyThemeImport, type ThemeApi } from "./theme-commands";

/**
 * Spec §9.3: a `.vsix` that declares more than one theme asks which one to import.
 *
 * The UI answers with the archive entry name the manifest itself declared, alongside the token naming the archive
 * Main is already holding -- it never names a filesystem path (spec §18).
 */
export function ThemePickDialog({ store, api }: { store: AppStore; api: ThemeApi }) {
  const modal = useStore(store, (s) => s.modal);
  if (modal?.kind !== "themePick") return null;
  return <ThemePickForm store={store} api={api} token={modal.token} choices={modal.choices} />;
}

function ThemePickForm({
  store,
  api,
  token,
  choices,
}: {
  store: AppStore;
  api: ThemeApi;
  token: string;
  choices: VsixChoice[];
}) {
  // This component only ever mounts while the picker is open, so its mount lifetime IS the open window.
  useOverlayPresence(true);
  const [busy, setBusy] = useState(false);
  // m-1's rule, as RenameDialog does it: whatever had focus when the dialog opened gets it back on close.
  const opener = useRef(document.activeElement);
  useEffect(() => {
    return () => {
      const previous = opener.current;
      if (previous instanceof HTMLElement && document.contains(previous)) previous.focus();
      else getEditorHandle()?.focus();
    };
  }, []);

  const close = () => store.getState().closeModal();
  const choose = async (path: string) => {
    // One import at a time: a successful pick consumes the token, so a second request could only ever fail. The
    // buttons' own `disabled` is what enforces that; an explicit `if (busy) return` here was proven redundant by
    // mutation (removing it changed nothing at all), so it is not carried as dead defence.
    setBusy(true);
    try {
      await applyThemeImport(store, api, await api.importThemePick(token, path));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dialog-backdrop">
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="theme-pick-title"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            close();
          }
        }}
      >
        <h2 id="theme-pick-title">{strings.themes.pickTitle}</h2>
        <p>{strings.themes.pickHelp(choices.length)}</p>
        <div className="dialog-actions">
          {choices.map((choice, index) => (
            <button
              key={choice.path}
              type="button"
              className={index === 0 ? "primary" : undefined}
              disabled={busy}
              // biome-ignore lint/a11y/noAutofocus: the dialog exists only to make this choice
              autoFocus={index === 0}
              onClick={() => void choose(choice.path)}
            >
              {choice.label}
            </button>
          ))}
          <button type="button" onClick={close}>
            {strings.themes.cancel}
          </button>
        </div>
      </div>
    </div>
  );
}
