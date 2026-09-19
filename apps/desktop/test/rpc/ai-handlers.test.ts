import { describe, expect, mock, test } from "bun:test";
import type { AiError, AiSendParams } from "@jslab/rpc-schema";
import { type ConversationTurn, defaultSettings, mergeSettings, type Settings } from "@jslab/shared";
import { type AiProviderAdapter, AiRequestError, createAdapterRegistry } from "../../src/main/ai/provider";
import { createAiHandlers } from "../../src/main/rpc/ai-handlers";

/**
 * `createValidators`' `message` wrapper is fire-and-forget -- it returns void, not the handler's promise -- so
 * every message test calls the handler and then flushes. Without this, "nothing was sent" passes vacuously.
 */
const flush = () => Bun.sleep(10);

const settingsWith = (ai: Record<string, unknown>): Settings => mergeSettings(defaultSettings(), { ai } as never);

const params = (overrides: Partial<AiSendParams> = {}): AiSendParams => ({
  requestId: crypto.randomUUID(),
  tabId: "t1",
  prompt: "why?",
  code: "const a = 1;",
  language: "typescript",
  runtime: "bun",
  history: [],
  ...overrides,
});

interface FakeAdapterOptions {
  id?: AiProviderAdapter["id"];
  needsApiKey?: boolean;
  chat?: AiProviderAdapter["chat"];
}

function fakeAdapter(options: FakeAdapterOptions = {}) {
  const seen: { apiKey: string | null; model: string; baseUrl: string }[] = [];
  const adapter: AiProviderAdapter = {
    id: options.id ?? "ollama",
    needsApiKey: options.needsApiKey ?? false,
    chat:
      options.chat ??
      (async (request, onChunk) => {
        seen.push({ apiKey: request.apiKey, model: request.model, baseUrl: request.baseUrl });
        onChunk("hello");
      }),
    listModels: async () => [],
  };
  return { adapter, seen };
}

function setup(options: { settings?: Settings; adapter?: AiProviderAdapter; key?: string | null } = {}) {
  const chunks: { requestId: string; text: string }[] = [];
  const dones: { requestId: string; stopped: boolean }[] = [];
  const errors: AiError[] = [];
  const built = options.adapter ? { adapter: options.adapter, seen: [] } : fakeAdapter();
  const get = mock(async (_account: string) => options.key ?? null);
  const saved: ConversationTurn[][] = [];
  const handlers = createAiHandlers({
    settings: { current: options.settings ?? settingsWith({ provider: "ollama" }) },
    secrets: { get },
    registry: createAdapterRegistry([built.adapter]),
    // A copy per call, so a later mutation of the array the handler was given cannot rewrite history here.
    conversation: { save: (messages) => saved.push([...messages]) },
    send: {
      chunk: (payload) => chunks.push(payload),
      done: (payload) => dones.push(payload),
      error: (payload) => errors.push(payload),
    },
    log: () => {},
  });
  return { handlers, chunks, dones, errors, get, saved, seen: built.seen };
}

const savedTurn = (id: string, content: string): ConversationTurn => ({
  id,
  role: "user",
  content,
  stopped: false,
});

describe("ai.conversationSave (spec §14.3)", () => {
  test("hands the whole transcript to the store", async () => {
    const { handlers, saved } = setup();
    handlers.messages["ai.conversationSave"]({ messages: [savedTurn("a", "why?"), savedTurn("b", "because")] });
    await flush();

    expect(saved).toHaveLength(1);
    expect(saved[0]?.map((turn) => turn.content)).toEqual(["why?", "because"]);
  });

  test("New Chat's empty transcript is passed through, not mistaken for nothing to do", async () => {
    const { handlers, saved } = setup();
    handlers.messages["ai.conversationSave"]({ messages: [] });
    await flush();

    expect(saved).toEqual([[]]);
  });

  /**
   * Spec §18: every inbound payload is validated before use. A malformed save must never reach the store,
   * because the store writes what it is given and the next launch has to be able to read it back.
   */
  test("a payload that is not a conversation is rejected, and nothing is written", async () => {
    const { handlers, saved } = setup();
    handlers.messages["ai.conversationSave"]({ messages: [{ id: "a", content: "no role" }] });
    handlers.messages["ai.conversationSave"]({ messages: "not an array" });
    handlers.messages["ai.conversationSave"]({});
    await flush();

    expect(saved).toEqual([]);
  });

  test("a build with no conversation store wired simply does nothing, rather than throwing", async () => {
    const { adapter } = fakeAdapter();
    const handlers = createAiHandlers({
      settings: { current: settingsWith({ provider: "ollama" }) },
      registry: createAdapterRegistry([adapter]),
      send: { chunk: () => {}, done: () => {}, error: () => {} },
      log: () => {},
    });
    expect(() => handlers.messages["ai.conversationSave"]({ messages: [savedTurn("a", "x")] })).not.toThrow();
    await flush();
  });
});

describe("ai.send / ai.stop (spec §14.3)", () => {
  test("a configured provider streams chunks and then a done", async () => {
    const { handlers, chunks, dones, errors } = setup();
    const request = params();
    handlers.messages["ai.send"](request);
    await flush();

    expect(chunks).toEqual([{ requestId: request.requestId, text: "hello" }]);
    expect(dones).toEqual([{ requestId: request.requestId, stopped: false }]);
    expect(errors).toEqual([]);
  });

  test("no provider configured answers with notConfigured instead of hanging", async () => {
    const { handlers, errors, chunks } = setup({ settings: settingsWith({ provider: "none" }) });
    handlers.messages["ai.send"](params());
    await flush();

    expect(errors).toHaveLength(1);
    expect(errors[0]?.kind).toBe("notConfigured");
    expect(chunks).toEqual([]);
  });

  /**
   * `ai.provider` accepts all six ids so a value written by a later build survives a downgrade. This is the other
   * half of that decision: a provider with no adapter in THIS build must be refused with a reason, not left to
   * spin.
   */
  test("a provider this build does not implement is refused, naming it", async () => {
    const { handlers, errors } = setup({ settings: settingsWith({ provider: "anthropic" }) });
    handlers.messages["ai.send"](params());
    await flush();

    expect(errors[0]?.kind).toBe("notConfigured");
    expect(errors[0]?.detail).toContain("anthropic");
  });

  /**
   * THE KEY SEAM, from the handler's side: the Keychain is consulted for EVERY provider through the one account
   * naming scheme, and the value is threaded into the adapter. Ollama simply has none stored.
   */
  test("the Keychain is read under ai.<provider> and the value reaches the adapter", async () => {
    const { handlers, get, seen } = setup({ key: "stored-token" });
    handlers.messages["ai.send"](params());
    await flush();

    expect(get).toHaveBeenCalledWith("ai.ollama");
    expect(seen[0]?.apiKey).toBe("stored-token");
  });

  test("a keyed provider with nothing stored is refused before any request is made", async () => {
    const chat = mock(async () => {});
    const { adapter } = fakeAdapter({ needsApiKey: true, chat });
    const { handlers, errors } = setup({ adapter, key: null });
    handlers.messages["ai.send"](params());
    await flush();

    expect(errors[0]?.kind).toBe("auth");
    // The point of `needsApiKey`: the refusal happens in the registry path, so no adapter has to remember it.
    expect(chat).not.toHaveBeenCalled();
  });

  test("the model and base URL are resolved from settings, falling back to the manifest", async () => {
    const { handlers, seen } = setup();
    handlers.messages["ai.send"](params());
    await flush();
    expect(seen[0]).toMatchObject({ model: "qwen2.5:7b-instruct", baseUrl: "http://localhost:11434" });

    const configured = setup({
      settings: settingsWith({
        provider: "ollama",
        "model.ollama": "mistral:latest",
        "baseUrl.ollama": "http://elsewhere:11434/",
      }),
    });
    configured.handlers.messages["ai.send"](params());
    await flush();
    expect(configured.seen[0]).toMatchObject({ model: "mistral:latest", baseUrl: "http://elsewhere:11434" });
  });

  test("ai.stop aborts the in-flight request and reports it as stopped, not as a failure", async () => {
    let aborted = false;
    const { adapter } = fakeAdapter({
      chat: async (request) => {
        // A provider that never finishes on its own: only the abort can end it.
        await new Promise<void>((resolve, reject) => {
          request.signal.addEventListener("abort", () => {
            aborted = true;
            reject(new AiRequestError("network", "aborted"));
          });
          setTimeout(resolve, 5_000);
        });
      },
    });
    const { handlers, dones, errors } = setup({ adapter });
    const request = params();
    handlers.messages["ai.send"](request);
    await Bun.sleep(5);
    handlers.messages["ai.stop"]({ requestId: request.requestId });
    await flush();

    expect(aborted).toBe(true);
    expect(dones).toEqual([{ requestId: request.requestId, stopped: true }]);
    // A stop the user asked for is a finished turn, not an error to report.
    expect(errors).toEqual([]);
  });

  test("a chunk that arrives after Stop is dropped rather than extending the reply", async () => {
    // An array rather than a `let`: TypeScript narrows a `let` assigned only inside a callback to `null`, so the
    // later call would not typecheck.
    const emitters: ((text: string) => void)[] = [];
    const { adapter } = fakeAdapter({
      chat: async (_request, onChunk) => {
        emitters.push(onChunk);
        await Bun.sleep(40);
        onChunk("late");
      },
    });
    const { handlers, chunks } = setup({ adapter });
    const request = params();
    handlers.messages["ai.send"](request);
    await Bun.sleep(5);
    emitters[0]?.("early");
    handlers.messages["ai.stop"]({ requestId: request.requestId });
    await Bun.sleep(60);

    expect(chunks.map((chunk) => chunk.text)).toEqual(["early"]);
  });

  test("a stop for a request that already finished is ignored rather than throwing", async () => {
    const { handlers, dones, errors } = setup();
    const request = params();
    handlers.messages["ai.send"](request);
    await flush();
    handlers.messages["ai.stop"]({ requestId: request.requestId });
    await flush();

    expect(dones).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  test("an adapter failure is classified and sent as ai.error", async () => {
    const { adapter } = fakeAdapter({
      chat: async () => {
        throw new AiRequestError("rateLimit", "slow down");
      },
    });
    const { handlers, errors, dones } = setup({ adapter });
    handlers.messages["ai.send"](params());
    await flush();

    expect(errors[0]?.kind).toBe("rateLimit");
    expect(errors[0]?.detail).toBe("slow down");
    expect(dones).toEqual([]);
  });

  test("an invalid payload is dropped without reaching a provider (spec §18)", async () => {
    const chat = mock(async () => {});
    const { adapter } = fakeAdapter({ chat });
    const { handlers, errors } = setup({ adapter });
    handlers.messages["ai.send"]({ requestId: "not-a-uuid", prompt: "" });
    await flush();

    expect(chat).not.toHaveBeenCalled();
    expect(errors).toEqual([]);
  });
});
