import { aiModelsListParamsSchema, type SettingsWindowRequests } from "@jslab/rpc-schema";
import type { AiModelListService } from "../ai/model-list";
import { createValidators, type Log } from "./validate";

/**
 * `ai.models.list` (TL-23), registered on the SETTINGS window's RPC in `index.ts`.
 *
 * The same shape as `font-handlers.ts`: validate the payload, delegate to the service that owns the coalescing
 * and the cache. The service never rejects, so this returns its classified answer straight to the view.
 */
export function createAiModelHandlers(deps: { models: Pick<AiModelListService, "list">; log: Log }) {
  const { parse } = createValidators(deps.log);
  return {
    requests: {
      "ai.models.list": (input: unknown) => {
        const { provider, refresh } = parse(aiModelsListParamsSchema, "ai.models.list", input);
        return deps.models.list(provider, refresh);
      },
    },
    messages: {},
  };
}

/**
 * The same drift guard `ai-handlers.ts` carries, against the SETTINGS window's request table.
 *
 * This is what proves TL-23 landed on the surface the Settings window can actually reach: an `ai.models.*` entry
 * on `SettingsWindowRequests` with no handler here fails typecheck, and a handler here that is not on that table
 * -- because it was put on `MainRequests` by mistake, say -- fails too.
 */
type AiModelHandlers = ReturnType<typeof createAiModelHandlers>;
type RequestDrift =
  | Exclude<Extract<keyof SettingsWindowRequests, `ai.models.${string}`>, keyof AiModelHandlers["requests"]>
  | Exclude<keyof AiModelHandlers["requests"], Extract<keyof SettingsWindowRequests, `ai.models.${string}`>>;
const _noRequestDrift: [RequestDrift] extends [never] ? true : false = true;
