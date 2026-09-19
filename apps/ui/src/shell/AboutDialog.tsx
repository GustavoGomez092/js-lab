import { useEffect, useRef } from "react";
import { useStore } from "zustand";
import type { MainApi } from "../api";
import type { AppStore } from "../state/store";
import { strings } from "../strings";
import { useOverlayPresence } from "./overlay-presence";
import { useSheetFocus } from "./sheet-focus";

/** Only the one action this dialog sends, so nothing else in `MainApi` has to exist for it to be rendered. */
type AboutApi = Pick<MainApi, "appCommand">;

/**
 * M6: About, credits and open-source notices.
 *
 * Replaces the native `{ role: "about" }` panel (see `apps/desktop/src/main/menu.ts`). The native panel can only
 * show what `Info.plist` carries -- it has no way to name the Bun or Electrobun version JSLab actually runs on,
 * and no way to open THIRD-PARTY-NOTICES.md -- so keeping both would mean two "About JSLab" that disagree.
 *
 * The notices file is NOT read or bundled here. Main stages it into the app bundle and owns its path
 * (`app-paths.ts`'s `noticesFile`); this dialog only names the action, exactly as the three Help links do.
 */
export function AboutDialog({ store, api }: { store: AppStore; api: AboutApi }) {
  const modal = useStore(store, (s) => s.modal);
  if (modal?.kind !== "about") return null;
  return <AboutPanel store={store} api={api} />;
}

function AboutPanel({ store, api }: { store: AppStore; api: AboutApi }) {
  // This component only ever mounts while the dialog is open, so its mount lifetime IS the open window --
  // the same contract RenameDialog and ThemePickDialog rely on.
  useOverlayPresence(true);
  const versions = useStore(store, (s) => s.versions);
  const panel = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  // Tab trapping AND focus restore in one place. ConfirmDialog's trap is welded to the confirm modal, and
  // Rename/ThemePick restore focus without trapping Tab, so this is the closest existing fit rather than a
  // fourth hand-rolled mechanism. `useSheetFocus` deliberately never sets INITIAL focus, so this does.
  useSheetFocus(true, panel);
  // An explicit focus call rather than `autoFocus`: this dialog is informational, so its dismiss control is
  // where focus belongs, and a real assertion can prove it landed there.
  useEffect(() => {
    closeButton.current?.focus();
  }, []);
  const close = () => store.getState().closeModal();

  return (
    <div className="dialog-backdrop">
      <div
        className="dialog about-dialog"
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="about-title"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            close();
          }
        }}
      >
        <h2 id="about-title">{strings.about.title}</h2>
        <ul className="about-facts" data-testid="about-facts">
          {/* Rendered only when Main actually sent the version, so a missing one reads as absent rather than
              as a confident "undefined". */}
          {versions?.app ? <li>{strings.about.version(versions.app)}</li> : null}
          {versions?.bun ? <li>{strings.about.bun(versions.bun)}</li> : null}
          {versions?.electrobun ? <li>{strings.about.electrobun(versions.electrobun)}</li> : null}
        </ul>
        <p className="about-license">
          {strings.about.license}
          <br />
          {strings.about.copyright}
        </p>
        <div className="dialog-actions">
          <button
            type="button"
            // A stable hook for the E2E agent's `e2e.aboutNotices` trigger (ST-13), which clicks this real
            // button rather than dispatching the action behind it.
            data-testid="about-notices"
            onClick={() => api.appCommand("openThirdPartyNotices")}
          >
            {strings.about.thirdParty}
          </button>
          <button type="button" className="primary" ref={closeButton} onClick={close}>
            {strings.about.close}
          </button>
        </div>
      </div>
    </div>
  );
}
