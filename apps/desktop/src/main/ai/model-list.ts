import type { AiModelList } from "@jslab/rpc-schema";
import { type AiProvider, isAiProviderAvailable, type Settings } from "@jslab/shared";
import { aiAccount } from "../secrets/keychain";
import { readProviderSetting, resolveBaseUrl } from "./models";
import { type AdapterRegistry, type AiProviderAdapter, AiRequestError } from "./provider";

/**
 * TL-23's model list: the models a provider actually reports, behind one coalesced request per endpoint.
 *
 * Shaped on `platform/system-fonts.ts`, which solves the same problem for the other scanned, refreshable list in
 * this app -- a `#inflight` promise so concurrent callers share one trip, a freshness window so reopening the AI
 * tab does not re-ask, and a backoff so a provider that is down is not contacted again on every render.
 *
 * One thing DOES differ from the font precedent, deliberately. `SystemFontsService.list()` returns immediately
 * with `refreshing: true` and the Settings window polls it, because a font scan is a background sweep with no
 * control of its own. This one awaits instead: TL-23's Refresh is an explicit user action with a button to
 * disable and a spinner to show, so there is nothing for a caller to poll and no `refreshing` flag to report.
 * The anti-stampede property is unchanged -- it comes from the shared promise, not from the polling.
 *
 * It never rejects. Every failure comes back as a classified `error` plus the provider's own `detail`, because
 * the caller is a settings field that has to stay usable when the provider is unreachable: spec §14.3's rule is
 * that Main classifies and the UI translates.
 */

/** How long a fetched list answers without going back to the server. */
export const AI_MODEL_LIST_MAX_AGE_MS = 60_000;
/** After a failed list, an automatic (non-Refresh) call reports the same failure instead of re-asking. */
export const AI_MODEL_LIST_RETRY_MS = 10_000;
/** Bounds one `listModels` call, so a provider that accepts a socket and never answers cannot hang the request. */
export const AI_MODEL_LIST_TIMEOUT_MS = 10_000;

interface CachedList {
  models: string[];
  at: number;
}

interface FailedList {
  /** The failure itself, replayed during the backoff so the reason stays honest rather than becoming "network". */
  result: AiModelList;
  at: number;
}

export interface AiModelListDeps {
  registry: AdapterRegistry;
  settings: { readonly current: Settings };
  /** The Keychain. Optional, exactly as in `ai-handlers.ts`: no provider this build ships needs a key. */
  secrets?: { get(account: string): Promise<string | null> };
  now?(): number;
  maxAgeMs?: number;
  retryMs?: number;
  timeoutMs?: number;
  /** Injected so a test can supply a signal it controls; production uses `AbortSignal.timeout`. */
  signal?(ms: number): AbortSignal;
  log(message: string, detail?: unknown): void;
}

export class AiModelListService {
  #inflight = new Map<string, Promise<AiModelList>>();
  #cached = new Map<string, CachedList>();
  #failed = new Map<string, FailedList>();

  constructor(private readonly deps: AiModelListDeps) {}

  /** The provider's models. `refresh` is TL-23's Refresh control: ignore the cache and the failure backoff. */
  async list(provider: string, refresh: boolean): Promise<AiModelList> {
    // The same two questions `ai-handlers.ts` asks, kept separate for the same reason: "configured" and
    // "implemented in this build" are different, and a downgraded profile must be told which one it failed.
    if (!isAiProviderAvailable(provider)) {
      return { models: null, error: "notConfigured", detail: `${provider} is not available in this build` };
    }
    const adapter = this.deps.registry.get(provider);
    if (!adapter) {
      return { models: null, error: "notConfigured", detail: `${provider} has no adapter in this build` };
    }

    const baseUrl = resolveBaseUrl(provider, readProviderSetting(this.deps.settings.current, "baseUrl", provider));
    // Keyed by ENDPOINT and not merely by provider: a corrected Base URL is a different server, and answering it
    // from the old one's cache is exactly how a fixed setting would look like it had not been fixed.
    const key = `${provider}\n${baseUrl}`;
    const now = (this.deps.now ?? Date.now)();

    // Checked FIRST, before the cache and before the backoff: a Refresh that lands while a list is already in
    // the air joins that one instead of opening a second socket. This is the anti-stampede seam.
    const shared = this.#inflight.get(key);
    if (shared) return shared;

    if (!refresh) {
      const cached = this.#cached.get(key);
      if (cached && now - cached.at <= (this.deps.maxAgeMs ?? AI_MODEL_LIST_MAX_AGE_MS)) {
        return { models: cached.models, error: null, detail: "" };
      }
      const failed = this.#failed.get(key);
      if (failed && now - failed.at < (this.deps.retryMs ?? AI_MODEL_LIST_RETRY_MS)) return failed.result;
    }

    const run = this.#fetch(provider, adapter, baseUrl, key);
    this.#inflight.set(key, run);
    return run;
  }

  async #fetch(provider: AiProvider, adapter: AiProviderAdapter, baseUrl: string, key: string): Promise<AiModelList> {
    try {
      const apiKey = await this.#apiKey(provider, adapter);
      const timeoutMs = this.deps.timeoutMs ?? AI_MODEL_LIST_TIMEOUT_MS;
      const signal = (this.deps.signal ?? ((ms: number) => AbortSignal.timeout(ms)))(timeoutMs);
      // Deduplicated: this is a remote server's JSON, and two entries of the same name would collide as React
      // keys in the picker. Insertion order is kept, so the provider's own ordering survives.
      const models = [...new Set(await adapter.listModels({ baseUrl, apiKey, signal }))];
      this.#cached.set(key, { models, at: (this.deps.now ?? Date.now)() });
      this.#failed.delete(key);
      return { models, error: null, detail: "" };
    } catch (error) {
      const classified =
        error instanceof AiRequestError
          ? error
          : new AiRequestError("unknown", error instanceof Error ? error.message : String(error));
      const result: AiModelList = { models: null, error: classified.kind, detail: classified.detail };
      this.#failed.set(key, { result, at: (this.deps.now ?? Date.now)() });
      this.deps.log("Couldn't list the AI provider's models", classified.detail);
      return result;
    } finally {
      this.#inflight.delete(key);
    }
  }

  /**
   * The key, resolved the same way `ai.send` resolves it: looked up for EVERY provider through the one account
   * naming scheme, so Ollama simply resolves to null and takes the identical path a keyed provider will take.
   */
  async #apiKey(provider: AiProvider, adapter: AiProviderAdapter): Promise<string | null> {
    let apiKey: string | null = null;
    try {
      apiKey = (await this.deps.secrets?.get(aiAccount(provider))) ?? null;
    } catch (error) {
      // A Keychain that cannot be read is not a reason to list models over an unauthenticated connection.
      this.deps.log("Couldn't read the AI provider key from the Keychain", String(error));
      if (adapter.needsApiKey) throw new AiRequestError("auth", "Couldn't read the stored API key from the Keychain");
    }
    if (adapter.needsApiKey && !apiKey) throw new AiRequestError("auth", `No API key is stored for ${provider}`);
    return apiKey;
  }
}
