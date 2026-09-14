import { listThemes } from "@jslab/themes";
import type { MainApi } from "../api";
import type { CommandSpec } from "../commands/registry";
import { writeSetting, writeSettings } from "../commands/settings-writer";
import type { AppStore } from "../state/store";
import { strings } from "../strings";

const KNOWN = new Set(listThemes().map((theme) => theme.id));

export function createThemeCommands(store: AppStore, api: Pick<MainApi, "updateSettings">): CommandSpec[] {
  return [
    {
      id: "theme.select",
      run: async (args) => {
        const themeId = (args as { themeId?: unknown } | undefined)?.themeId;
        if (typeof themeId !== "string" || !KNOWN.has(themeId)) return;
        await writeSettings(store, api, { appearance: { theme: themeId, followSystem: false } });
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
