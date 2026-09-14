import type { SettingsUpdateParams } from "@jslab/rpc-schema";
import { readSetting, type SettingKey, settingPatch } from "@jslab/shared";
import type { MainApi } from "../api";
import type { AppStore } from "../state/store";
import type { CommandSpec } from "./registry";

/**
 * A command that reads one boolean Settings field, flips it, and persists the patch through Main. Shared by
 * app-commands.ts's run/output toggles and view-commands.ts's view toggles, which were previously two copies
 * of the same read/negate/patch/updateSettings logic (fix round 1, review m-3).
 */
export function toggleSettingCommand(
  id: CommandSpec["id"],
  key: SettingKey,
  store: AppStore,
  api: Pick<MainApi, "updateSettings">,
  description?: () => string | null,
): CommandSpec {
  return {
    id,
    run: async () => {
      const current = store.getState().settings;
      if (!current) return;
      const patch = settingPatch(key, !readSetting(current, key)) as SettingsUpdateParams["patch"];
      store.getState().updateSettings(await api.updateSettings(patch));
    },
    ...(description ? { description } : {}),
  };
}
