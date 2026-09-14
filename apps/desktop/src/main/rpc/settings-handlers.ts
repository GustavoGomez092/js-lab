import { e2eResponseSchema, emptyParamsSchema, settingsUpdateParamsSchema } from "@jslab/rpc-schema";
import type { DeepPartial, Settings } from "@jslab/shared";
import type { E2EBridge } from "../cli/e2e-bridge";
import type { SettingsStore } from "../services/settings-store";
import { createValidators, type Log } from "./validate";

export interface SettingsHandlerDeps {
  settings: Pick<SettingsStore, "current" | "update">;
  e2e: boolean;
  log: Log;
}

/** `settings.get` / `settings.update`, served to both the main window and the Settings window (spec §8). */
export function createSettingsHandlers(deps: SettingsHandlerDeps) {
  const { parse } = createValidators(deps.log);
  return {
    requests: {
      "settings.get": (input: unknown): { settings: Settings; e2e: boolean } => {
        parse(emptyParamsSchema, "settings.get", input);
        return { settings: deps.settings.current, e2e: deps.e2e };
      },
      "settings.update": (input: unknown): Promise<Settings> =>
        deps.settings.update(
          parse(settingsUpdateParamsSchema, "settings.update", input).patch as DeepPartial<Settings>,
        ),
    },
    messages: {},
  };
}

/** `e2e.response` for windows other than the main window, which has it in its core handlers. */
export function createE2EResponseHandler(bridge: Pick<E2EBridge, "receive">, log: Log) {
  const { message } = createValidators(log);
  return {
    requests: {},
    messages: { "e2e.response": message(e2eResponseSchema, "e2e.response", (response) => bridge.receive(response)) },
  };
}
