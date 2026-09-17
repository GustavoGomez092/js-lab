import type { ThemeImportResult } from "@jslab/rpc-schema";
import { listThemes } from "@jslab/themes";
import type { MainApi } from "../api";
import type { CommandSpec } from "../commands/registry";
import { writeSetting, writeSettings } from "../commands/settings-writer";
import type { AppStore } from "../state/store";
import { strings } from "../strings";

/** Widened for Task 8: the import round trip is two requests, and the picker dialog replays the second one. */
export type ThemeApi = Pick<MainApi, "updateSettings" | "importTheme" | "importThemePick">;

/**
 * Applies whatever an import answered, for both the command and the `.vsix` picker.
 *
 * Three shapes, and the third is the one that is easy to get wrong: Main reports a cancelled file dialog as a
 * refusal with an EMPTY message, which must produce no status line at all rather than an empty one.
 */
export async function applyThemeImport(store: AppStore, api: ThemeApi, result: ThemeImportResult): Promise<void> {
  if (result.ok && "theme" in result) {
    await writeSettings(store, api, { appearance: { theme: result.theme.id, followSystem: false } });
    // Only the picker is dismissed by a successful import; a plain .json import must not close whatever else is open.
    if (store.getState().modal?.kind === "themePick") store.getState().closeModal();
    store.getState().setStatusMessage([strings.themes.imported(result.theme.name), ...result.notes].join(" "));
    return;
  }
  if (result.ok) {
    store.getState().openModal({ kind: "themePick", token: result.token, choices: result.choices });
    return;
  }
  if (result.error) store.getState().setStatusMessage(result.error);
}

export function createThemeCommands(store: AppStore, api: ThemeApi): CommandSpec[] {
  return [
    {
      id: "theme.select",
      run: async (args) => {
        const themeId = (args as { themeId?: unknown } | undefined)?.themeId;
        // Task 4's finding: `listThemes()` grows when a theme is imported, so the known set has to be read at
        // dispatch time. The module-level `const KNOWN` this replaces was built once at import, before
        // `registerUserThemes` could ever have run, so every imported theme picked from the palette or the native
        // menu was silently swallowed here -- listed on all four surfaces, selectable from two.
        if (typeof themeId !== "string" || !listThemes().some((theme) => theme.id === themeId)) return;
        await writeSettings(store, api, { appearance: { theme: themeId, followSystem: false } });
      },
    },
    {
      id: "theme.import",
      run: async () => {
        await applyThemeImport(store, api, await api.importTheme());
      },
    },
    {
      id: "theme.toggleFollowSystem",
      // FB-m6: a rapid second toggle flips back instead of repeating the first flip.
      run: () => writeSetting(store, api, "appearance.followSystem", (followSystem) => !followSystem),
      description: () => strings.commands.onOff(Boolean(store.getState().settings?.appearance.followSystem)),
    },
  ];
}
