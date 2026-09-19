import {
  type AiError,
  type AiSendParams,
  aiSendParamsSchema,
  aiStopParamsSchema,
  type MainMessages,
} from "@jslab/rpc-schema";
import { AI_PROVIDER_NONE, type AiProvider, isAiProviderAvailable, type Settings } from "@jslab/shared";
import { buildMessages } from "../ai/context";
import { resolveBaseUrl, resolveModel } from "../ai/models";
import { createOllamaAdapter } from "../ai/ollama";
import { type AdapterRegistry, AiRequestError, createAdapterRegistry } from "../ai/provider";
import { aiAccount } from "../secrets/keychain";
import { createValidators, type Log } from "./validate";

/**
 * `ai.send` / `ai.stop` (spec §14.3).
 *
 * The security model is the reason this file exists at all: "Requests go through Main" and "Keys never reach the
 * webview". The renderer sends a prompt and its context and receives decoded text; it never learns the base URL's
 * credentials, never holds a key, and never opens a connection to a provider.
 */

/**
 * How many requests may be in flight at once.
 *
 * The panel only ever has one, so this is not a throughput knob -- it bounds what a renderer that sent `ai.send`
 * in a loop could make Main hold open. Each in-flight entry owns a socket and an abort controller.
 */
export const MAX_INFLIGHT_AI_REQUESTS = 4;

export interface AiHandlerDeps {
  settings: { readonly current: Settings };
  /** The Keychain (`secrets/keychain.ts`). Optional: absent in headless tests, where no provider needs a key. */
  secrets?: { get(account: string): Promise<string | null> };
  registry: AdapterRegistry;
  send: {
    chunk(payload: { requestId: string; text: string }): void;
    done(payload: { requestId: string; stopped: boolean }): void;
    error(payload: AiError): void;
  };
  log: Log;
}

interface Inflight {
  controller: AbortController;
  /** Set by `ai.stop`, so an abort the USER asked for is reported as `done{stopped}` and not as an error. */
  stopped: boolean;
}

/**
 * Which provider to use, or why none can be.
 *
 * `ai.provider` accepts all six ids so a value written by a later build survives a downgrade (see
 * `AI_PROVIDERS`), which means "configured" and "implemented here" are genuinely different questions and both
 * have to be asked. Answering only the first is how a downgraded profile would sit on a spinner forever.
 */
function selectProvider(settings: Settings, registry: AdapterRegistry) {
  const configured = settings.ai.provider;
  if (configured === AI_PROVIDER_NONE) {
    return { ok: false as const, detail: "No AI provider is configured" };
  }
  if (!isAiProviderAvailable(configured)) {
    return { ok: false as const, detail: `${configured} is not available in this build` };
  }
  const adapter = registry.get(configured);
  if (!adapter) {
    return { ok: false as const, detail: `${configured} has no adapter in this build` };
  }
  return { ok: true as const, provider: configured as AiProvider, adapter };
}

export function createAiHandlers(deps: AiHandlerDeps) {
  const { message } = createValidators(deps.log);
  const inflight = new Map<string, Inflight>();

  const fail = (requestId: string, error: unknown): void => {
    const classified =
      error instanceof AiRequestError
        ? error
        : new AiRequestError("unknown", error instanceof Error ? error.message : String(error));
    deps.send.error({ requestId, kind: classified.kind, detail: classified.detail });
  };

  async function run(params: AiSendParams): Promise<void> {
    if (inflight.has(params.requestId)) {
      deps.log("Ignored a duplicate ai.send", { requestId: params.requestId });
      return;
    }
    if (inflight.size >= MAX_INFLIGHT_AI_REQUESTS) {
      deps.send.error({
        requestId: params.requestId,
        kind: "unknown",
        detail: `Too many AI requests are already running (${MAX_INFLIGHT_AI_REQUESTS})`,
      });
      return;
    }

    const settings = deps.settings.current;
    const selected = selectProvider(settings, deps.registry);
    if (!selected.ok) {
      deps.send.error({ requestId: params.requestId, kind: "notConfigured", detail: selected.detail });
      return;
    }
    const { provider, adapter } = selected;

    // The key is looked up for EVERY provider, through the one Keychain account naming scheme (`ai.<provider>`,
    // spec §14.3). Ollama simply has none stored, so this resolves to null and the adapter sends no
    // Authorization header -- the same code path a keyed provider takes, with a different value in it.
    let apiKey: string | null = null;
    try {
      apiKey = (await deps.secrets?.get(aiAccount(provider))) ?? null;
    } catch (error) {
      // A Keychain that cannot be read is not a reason to send an unauthenticated request in silence.
      deps.log("Couldn't read the AI provider key from the Keychain", String(error));
      if (adapter.needsApiKey) {
        deps.send.error({
          requestId: params.requestId,
          kind: "auth",
          detail: "Couldn't read the stored API key from the Keychain",
        });
        return;
      }
    }
    if (adapter.needsApiKey && !apiKey) {
      deps.send.error({ requestId: params.requestId, kind: "auth", detail: `No API key is stored for ${provider}` });
      return;
    }

    const entry: Inflight = { controller: new AbortController(), stopped: false };
    inflight.set(params.requestId, entry);
    try {
      await adapter.chat(
        {
          model: resolveModel(provider, readProviderSetting(settings, "model", provider)),
          baseUrl: resolveBaseUrl(provider, readProviderSetting(settings, "baseUrl", provider)),
          apiKey,
          messages: buildMessages(params, { includeOutput: settings.ai.includeOutput }),
          signal: entry.controller.signal,
        },
        (text) => {
          // A chunk that arrives after Stop is dropped rather than appended: the user has already been shown the
          // reply as interrupted, and a late chunk would extend it after the fact.
          if (!entry.stopped) deps.send.chunk({ requestId: params.requestId, text });
        },
      );
      deps.send.done({ requestId: params.requestId, stopped: entry.stopped });
    } catch (error) {
      // Stop aborts the request, so the adapter rejects -- but the user asked for this, and it is a completed
      // turn as far as the panel is concerned, not a failure to report.
      if (entry.stopped) deps.send.done({ requestId: params.requestId, stopped: true });
      else fail(params.requestId, error);
    } finally {
      inflight.delete(params.requestId);
    }
  }

  return {
    requests: {},
    messages: {
      "ai.send": message(aiSendParamsSchema, "ai.send", (params) => run(params)),
      "ai.stop": message(aiStopParamsSchema, "ai.stop", ({ requestId }) => {
        const entry = inflight.get(requestId);
        // Not an error: Stop can race the stream's own end, and the panel has already stopped showing the button.
        if (!entry) return;
        entry.stopped = true;
        // The real abort. Without this the model goes on generating (and, for a metered provider, being billed)
        // while JSLab merely stops listening.
        entry.controller.abort();
      }),
    },
  };
}

/**
 * Reads `ai.model.<provider>` / `ai.baseUrl.<provider>`.
 *
 * The section's field names really do contain a dot (spec §8 writes the key as `ai.model.ollama`), so this reads
 * the field by its composed name rather than by walking a nested object -- there is no nested object to walk.
 */
function readProviderSetting(settings: Settings, field: "model" | "baseUrl", provider: AiProvider): string {
  const values = settings.ai as unknown as Record<string, unknown>;
  const value = values[`${field}.${provider}`];
  return typeof value === "string" ? value : "";
}

/**
 * The production wiring: the handlers with this build's one adapter already registered.
 *
 * `index.ts` calls this rather than assembling the registry itself, so the composition root imports one module
 * instead of three and adding the second provider is a change to this line alone.
 */
export function createOllamaAiHandlers(deps: Omit<AiHandlerDeps, "registry"> & { registry?: AdapterRegistry }) {
  const { registry, ...rest } = deps;
  return createAiHandlers({ ...rest, registry: registry ?? createAdapterRegistry([createOllamaAdapter()]) });
}

// The same drift guard `snippet-handlers.ts` carries: an `ai.*` entry added to MainMessages with no handler here
// fails typecheck, and a handler here with no wire entry fails too.
type AiHandlers = ReturnType<typeof createAiHandlers>;
type MessageDrift =
  | Exclude<Extract<keyof MainMessages, `ai.${string}`>, keyof AiHandlers["messages"]>
  | Exclude<keyof AiHandlers["messages"], Extract<keyof MainMessages, `ai.${string}`>>;
const _noMessageDrift: [MessageDrift] extends [never] ? true : false = true;
