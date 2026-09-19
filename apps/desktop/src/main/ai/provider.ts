import type { AiErrorKind, AiMessage } from "@jslab/rpc-schema";
import type { AiProvider } from "@jslab/shared";

/**
 * THE ADAPTER SEAM (spec §14.3).
 *
 * Six providers are specified; this build implements Ollama, which is the one that needs no credentials and can
 * therefore be tested end to end today. The shape below is deliberately the shape a KEYED provider needs, not the
 * shape Ollama needs, because the point of building one adapter first is to discover the seam -- and a seam
 * discovered from the only provider with no API key is exactly the seam that will not fit the other five.
 *
 * What that means concretely:
 *
 *   - `apiKey` is part of `AiRequest` and is resolved by the CALLER (Main's handler, from the Keychain) for every
 *     provider, Ollama included. Ollama resolves it to `null`. The key is therefore looked up, passed and
 *     threaded through the identical code path whichever provider is selected: OpenAI does not introduce a new
 *     argument, a new lookup or a new call site, it only starts receiving a non-null value.
 *   - `needsApiKey` is what makes "no key configured" a check the REGISTRY performs rather than something each
 *     adapter remembers to do. Ollama sets it false; the other five set it true and get the refusal for free.
 *   - `chat` reports text through `onChunk` and resolves when the provider says the turn is over. Every provider
 *     streams in a different envelope (NDJSON here, SSE for OpenAI/Anthropic/Mistral), so the envelope is the
 *     adapter's business and the caller only ever sees decoded text.
 *   - `listModels` exists for TL-23's Refresh button. It is on the interface because every provider in the table
 *     has a models endpoint; only Ollama's is implemented here.
 */
export interface AiRequest {
  model: string;
  /** Already resolved against `models.json` (blank settings mean the manifest's default). */
  baseUrl: string;
  /**
   * The provider's API key, or null for a provider that takes none.
   *
   * Never logged, never returned to the renderer, and never put in an error: spec §14.3 is explicit that keys
   * never reach the webview, and `secrets/keychain.ts` makes the same promise on the storage side.
   */
  apiKey: string | null;
  /** The full prompt, system message first (`context.ts` builds it). */
  messages: AiMessage[];
  signal: AbortSignal;
}

export interface AiProviderAdapter {
  readonly id: AiProvider;
  /** True for a provider that cannot work without a key, so the registry can refuse before any request is made. */
  readonly needsApiKey: boolean;
  /** Streams one assistant turn. Resolves when the provider ends the turn; rejects with `AiRequestError`. */
  chat(request: AiRequest, onChunk: (text: string) => void): Promise<void>;
  /** TL-23's Refresh: the model ids the provider offers. */
  listModels(request: Pick<AiRequest, "baseUrl" | "apiKey" | "signal">): Promise<string[]>;
}

/**
 * A classified failure. `kind` is what the UI translates; `detail` is the provider's own words, shown as data.
 *
 * Constructed with a `detail` that is built from the response only -- never from the request -- so an API key can
 * never be echoed into an error the renderer receives.
 */
export class AiRequestError extends Error {
  readonly kind: AiErrorKind;
  readonly detail: string;

  constructor(kind: AiErrorKind, detail: string) {
    super(`${kind}: ${detail}`);
    this.name = "AiRequestError";
    this.kind = kind;
    this.detail = detail;
  }
}

/**
 * Maps an HTTP status to the kinds spec §14.3 names. Shared by every adapter, so "what 401 means" is decided
 * once rather than per provider.
 */
export function errorKindForStatus(status: number): AiErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rateLimit";
  if (status === 404) return "modelNotFound";
  // 413 is the HTTP spelling of "your prompt is too big"; providers also say it in a 400 body, which the adapter
  // inspects separately.
  if (status === 413) return "contextTooLong";
  return "http";
}

/**
 * A registry over the seam. `get` returns null for a provider this build does not implement, which is what lets
 * `ai.provider` accept all six ids (so a value from a later build survives a downgrade) while this build refuses
 * five of them with a clear reason instead of appearing to work.
 */
export function createAdapterRegistry(adapters: readonly AiProviderAdapter[]) {
  const byId = new Map<string, AiProviderAdapter>(adapters.map((adapter) => [adapter.id, adapter]));
  return {
    get(provider: string): AiProviderAdapter | null {
      return byId.get(provider) ?? null;
    },
    get implemented(): AiProvider[] {
      return [...byId.values()].map((adapter) => adapter.id);
    },
  };
}
export type AdapterRegistry = ReturnType<typeof createAdapterRegistry>;
