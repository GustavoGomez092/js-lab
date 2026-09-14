import type { SettingsUpdateParams } from "@jslab/rpc-schema";
import { listThemes } from "@jslab/themes";
import type { MainApi } from "../api";
import type { CommandSpec } from "../commands/registry";
import type { AppStore } from "../state/store";
import { strings } from "../strings";

const KNOWN = new Set(listThemes().map((theme) => theme.id));

export function createThemeCommands(store: AppStore, api: Pick<MainApi, "updateSettings">): CommandSpec[] {
  const update = async (appearance: NonNullable<SettingsUpdateParams["patch"]["appearance"]>) => {
    store.getState().updateSettings(await api.updateSettings({ appearance }));
  };
  return [
    {
      id: "theme.select",
      run: async (args) => {
        const themeId = (args as { themeId?: unknown } | undefined)?.themeId;
        if (typeof themeId !== "string" || !KNOWN.has(themeId)) return;
        await update({ theme: themeId, followSystem: false });
      },
    },
    {
      id: "theme.toggleFollowSystem",
      run: () => update({ followSystem: !store.getState().settings?.appearance.followSystem }),
      description: () => strings.commands.onOff(Boolean(store.getState().settings?.appearance.followSystem)),
    },
  ];
}
