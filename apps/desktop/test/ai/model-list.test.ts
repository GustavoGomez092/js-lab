import { describe, expect, test } from "bun:test";
import { defaultSettings, mergeSettings, type Settings } from "@jslab/shared";
import { AiModelListService } from "../../src/main/ai/model-list";
import { type AiProviderAdapter, AiRequestError, createAdapterRegistry } from "../../src/main/ai/provider";

/**
 * TL-23's model list (`apps/desktop/src/main/ai/model-list.ts`).
 *
 * The literals here are deliberately NOT read back out of `models.json` or the settings schema: asserting the
 * resolved base URL against the same manifest the implementation reads would survive any mutation of the
 * resolving code. `http://localhost:11434` is written out because that is what a correct build must produce.
 */

const settingsWith = (ai: Record<string, unknown>): Settings => mergeSettings(defaultSettings(), { ai } as never);

interface AdapterCall {
  baseUrl: string;
  apiKey: string | null;
}

function fakeAdapter(options: { needsApiKey?: boolean; listModels?(): Promise<string[]> } = {}): {
  adapter: AiProviderAdapter;
  calls: AdapterCall[];
} {
  const calls: AdapterCall[] = [];
  return {
    calls,
    adapter: {
      id: "ollama",
      needsApiKey: options.needsApiKey ?? false,
      chat: async () => {},
      // Every call is recorded before delegating, so `calls.length` is a true count of trips to the server --
      // which is the whole measurement the coalescing and backoff tests below depend on.
      listModels: async (request) => {
        calls.push({ baseUrl: request.baseUrl, apiKey: request.apiKey });
        return options.listModels ? options.listModels() : ["llama3.2:3b", "mistral:latest"];
      },
    },
  };
}

function setup(
  options: {
    adapter?: AiProviderAdapter;
    calls?: AdapterCall[];
    settings?: Settings;
    secrets?: { get(account: string): Promise<string | null> };
    now?(): number;
    maxAgeMs?: number;
    retryMs?: number;
  } = {},
) {
  const built = options.adapter ? { adapter: options.adapter, calls: options.calls ?? [] } : fakeAdapter();
  const logged: string[] = [];
  const service = new AiModelListService({
    registry: createAdapterRegistry([built.adapter]),
    settings: { current: options.settings ?? defaultSettings() },
    ...(options.secrets ? { secrets: options.secrets } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.maxAgeMs === undefined ? {} : { maxAgeMs: options.maxAgeMs }),
    ...(options.retryMs === undefined ? {} : { retryMs: options.retryMs }),
    // No real timer: these tests never want a 10 s deadline pending after they finish.
    signal: () => new AbortController().signal,
    log: (message) => logged.push(message),
  });
  return { service, calls: built.calls, logged };
}

describe("AiModelListService (TL-23)", () => {
  test("returns the models the provider reports, at the endpoint a blank Base URL resolves to", async () => {
    const { service, calls } = setup();

    expect(await service.list("ollama", false)).toEqual({
      models: ["llama3.2:3b", "mistral:latest"],
      error: null,
      detail: "",
    });
    expect(calls).toEqual([{ baseUrl: "http://localhost:11434", apiKey: null }]);
  });

  test("a second list is answered from the cache, without a second trip to the server", async () => {
    const { service, calls } = setup();

    await service.list("ollama", false);
    await service.list("ollama", false);

    expect(calls).toHaveLength(1);
  });

  test("Refresh ignores the cache and asks the provider again", async () => {
    const { service, calls } = setup();

    await service.list("ollama", false);
    await service.list("ollama", true);

    expect(calls).toHaveLength(2);
  });

  test("concurrent callers share one request, so Refresh cannot stampede the server", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { adapter, calls } = fakeAdapter({
      listModels: async () => {
        await gate;
        return ["llama3.2:3b"];
      },
    });
    const { service } = setup({ adapter, calls });

    // All three are started before any of them can settle: one automatic load and two Refresh clicks.
    const pending = Promise.all([
      service.list("ollama", false),
      service.list("ollama", true),
      service.list("ollama", true),
    ]);
    release();
    const results = await pending;

    expect(calls).toHaveLength(1);
    expect(results.map((result) => result.models)).toEqual([["llama3.2:3b"], ["llama3.2:3b"], ["llama3.2:3b"]]);
  });

  test("a failed list is reported as a classified error and is never thrown", async () => {
    const { adapter, calls } = fakeAdapter({
      listModels: async () => {
        throw new AiRequestError("network", "connect ECONNREFUSED 127.0.0.1:11434");
      },
    });
    const { service, logged } = setup({ adapter, calls });

    expect(await service.list("ollama", false)).toEqual({
      models: null,
      error: "network",
      detail: "connect ECONNREFUSED 127.0.0.1:11434",
    });
    expect(logged).toContain("Couldn't list the AI provider's models");
  });

  test("after a failure the provider is left alone until the backoff expires, but Refresh overrides it", async () => {
    let at = 1_000;
    const { adapter, calls } = fakeAdapter({
      listModels: async () => {
        throw new AiRequestError("network", "down");
      },
    });
    const { service } = setup({ adapter, calls, now: () => at, retryMs: 10_000 });

    await service.list("ollama", false);
    expect(calls).toHaveLength(1);

    // Inside the backoff: the SAME failure is replayed, rather than being softened into a generic one.
    at = 5_000;
    expect(await service.list("ollama", false)).toEqual({ models: null, error: "network", detail: "down" });
    expect(calls).toHaveLength(1);

    // The user asking explicitly is not the case the backoff exists to prevent.
    await service.list("ollama", true);
    expect(calls).toHaveLength(2);

    at = 20_000;
    await service.list("ollama", false);
    expect(calls).toHaveLength(3);
  });

  test("a changed Base URL is not answered from the old endpoint's cache", async () => {
    const { adapter, calls } = fakeAdapter();
    let current = defaultSettings();
    const service = new AiModelListService({
      registry: createAdapterRegistry([adapter]),
      settings: {
        get current() {
          return current;
        },
      },
      signal: () => new AbortController().signal,
      log: () => {},
    });

    await service.list("ollama", false);
    current = settingsWith({ "baseUrl.ollama": "http://10.0.0.5:11434" });
    await service.list("ollama", false);

    expect(calls.map((call) => call.baseUrl)).toEqual(["http://localhost:11434", "http://10.0.0.5:11434"]);
  });

  test("a provider this build has no adapter for is refused as data, and is never contacted", async () => {
    const { service, calls } = setup();

    expect(await service.list("openai", false)).toEqual({
      models: null,
      error: "notConfigured",
      detail: "openai is not available in this build",
    });
    expect(calls).toHaveLength(0);
  });

  test("duplicate names from the server are collapsed, so the picker cannot render two identical options", async () => {
    const { adapter, calls } = fakeAdapter({
      listModels: async () => ["llama3.2:3b", "mistral:latest", "llama3.2:3b"],
    });
    const { service } = setup({ adapter, calls });

    expect((await service.list("ollama", false)).models).toEqual(["llama3.2:3b", "mistral:latest"]);
  });

  test("a provider that needs a key with none stored is refused before any request is made", async () => {
    const { adapter, calls } = fakeAdapter({ needsApiKey: true });
    const { service } = setup({ adapter, calls });

    expect(await service.list("ollama", false)).toEqual({
      models: null,
      error: "auth",
      detail: "No API key is stored for ollama",
    });
    expect(calls).toHaveLength(0);
  });

  test("a stored key is read from the provider's own Keychain account and handed to the adapter", async () => {
    const asked: string[] = [];
    const { service, calls } = setup({
      secrets: {
        get: async (account) => {
          asked.push(account);
          return account === "ai.ollama" ? "sk-test-value" : null;
        },
      },
    });

    await service.list("ollama", false);

    expect(asked).toEqual(["ai.ollama"]);
    expect(calls[0]?.apiKey).toBe("sk-test-value");
  });
});
