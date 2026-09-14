import type { SettingKey } from "@jslab/shared";
import type { MainApi } from "../api";
import type { AppStore } from "../state/store";
import type { CommandSpec } from "./registry";
import { writeSetting } from "./settings-writer";

/**
 * A command that flips one boolean Settings field and persists the patch through Main. Shared by app-commands.ts's
 * run/output toggles and view-commands.ts's view toggles (fix round 1, review m-3). Rapid repeats each flip, and a
 * late response never undoes a newer broadcast (FB-m6, settings-writer.ts).
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
    run: () => writeSetting(store, api, key, (value) => !value),
    ...(description ? { description } : {}),
  };
}
