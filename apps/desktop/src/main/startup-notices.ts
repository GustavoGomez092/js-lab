import type { StartupNotice } from "@jslab/rpc-schema";
import type { Settings } from "@jslab/shared";
import type { PrimaryFile, Recovery } from "./persistence/json-store";
import { type MainStrings, strings } from "./strings";

/** How one settings.json or session.json load went (SettingsStore and SessionStore expose these fields). */
export interface FileLoadReport {
  recovered: Recovery;
  newerVersion: number | null;
  primary: PrimaryFile;
  /** The corrupt-file copy saved during this launch's load, or null (FA-m4: never an earlier launch's copy). */
  corruptCopy: string | null;
}

export interface StartupNoticeInput {
  settings: FileLoadReport;
  session: FileLoadReport & { droppedTabs: readonly string[] };
}

function recoveryMessage(
  file: FileLoadReport,
  text: { reset: string; restored: string; restoredMissing: string },
): string {
  const base =
    file.recovered === "defaults" ? text.reset : file.primary === "missing" ? text.restoredMissing : text.restored;
  return `${base}${file.corruptCopy ? strings.notices.copySaved(file.corruptCopy) : ""}`;
}

/** What Main tells the user at startup (spec §20; final review M7 and I4). */
export function startupNotices(input: StartupNoticeInput): StartupNotice[] {
  const notices: StartupNotice[] = [];
  if (input.settings.recovered !== "none") {
    notices.push({
      id: "settingsRecovered",
      message: recoveryMessage(input.settings, {
        reset: strings.notices.settingsReset,
        restored: strings.notices.settingsRestored,
        restoredMissing: strings.notices.settingsRestoredMissing,
      }),
    });
  }
  if (input.session.recovered !== "none") {
    notices.push({
      id: "sessionRecovered",
      message: recoveryMessage(input.session, {
        reset: strings.notices.sessionReset,
        restored: strings.notices.sessionRestored,
        restoredMissing: strings.notices.sessionRestoredMissing,
      }),
    });
  }
  if (input.settings.newerVersion !== null) {
    notices.push({ id: "settingsNewer", message: strings.notices.settingsNewer(input.settings.newerVersion) });
  }
  if (input.session.newerVersion !== null) {
    notices.push({ id: "sessionNewer", message: strings.notices.sessionNewer(input.session.newerVersion) });
  }
  if (input.session.droppedTabs.length > 0) {
    notices.push({ id: "tabsDropped", message: strings.notices.tabsDropped(input.session.droppedTabs.length) });
  }
  return notices;
}

/**
 * Spec §17: "Changing the language needs a restart (a notice is shown)." The Settings window's field already
 * carries a static "Restart required" badge -- it is the one field in the whole window marked `restart: true` --
 * but that badge is in the *other* window. This is the notice in the main window, where the menus whose language
 * the user just changed actually live.
 *
 * `mergeSettings` re-parses the whole settings object, so every write produces a new `app` object. Compare the
 * field, never object identity, or this fires on an unrelated toggle.
 *
 * Takes `strings` as a parameter rather than reading the module binding: the binding is reassigned twice during
 * startup (`installStrings`), and a test that wants a known locale should not have to install one globally.
 */
export function languageChangeNotice(previous: Settings, next: Settings, text: MainStrings): StartupNotice | null {
  if (previous.app.uiLanguage === next.app.uiLanguage) return null;
  return { id: "languageChanged", message: text.notices.languageChanged };
}
