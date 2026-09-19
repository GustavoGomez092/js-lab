import { describe, expect, test } from "bun:test";
import { defaultSettings } from "@jslab/shared";
import { buildMessages } from "../src/main/ai/context";
import { AiModelListService } from "../src/main/ai/model-list";
import { createOllamaAdapter } from "../src/main/ai/ollama";
import { AiRequestError, createAdapterRegistry } from "../src/main/ai/provider";

/**
 * The live integration suite: the Ollama adapter against a REAL local server.
 *
 * Everything else about this provider is unit-tested against an injected `fetch`, which proves the adapter's
 * logic but cannot prove that its understanding of Ollama's wire format is correct. Only a real server can do
 * that -- and Ollama is the one provider where a real server costs no credentials, which is why this milestone
 * built it first.
 *
 * SKIPPED, never failed, when no server is listening: a developer without Ollama installed must still get a
 * green suite. The probe is a real request rather than a port check, so a socket held by something that is not
 * Ollama skips too.
 */
const BASE_URL = process.env.JSLAB_OLLAMA_BASE_URL ?? "http://127.0.0.1:11434";

async function probe(baseUrl: string = BASE_URL): Promise<string[]> {
  try {
    const response = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(2_000) });
    if (!response.ok) return [];
    const body = (await response.json()) as { models?: { name?: unknown }[] };
    return (body.models ?? []).map((entry) => entry?.name).filter((name): name is string => typeof name === "string");
  } catch {
    return [];
  }
}

const available = await probe();
// Prefer an instruction-tuned model: a base model answers a question with more of the question.
const model = available.find((name) => name.includes("instruct")) ?? available[0] ?? "";
const live = available.length > 0 ? test : test.skip;

/**
 * TL-23's service resolves the MANIFEST's default endpoint when `ai.baseUrl.ollama` is blank, and that default
 * is spelled `localhost` -- not the `127.0.0.1` this suite probes above, and not whatever
 * `JSLAB_OLLAMA_BASE_URL` may point at. Normally the same server; not necessarily. So it gets its own probe and
 * skips on its own terms rather than borrowing a result that might describe a different machine.
 *
 * Written out as a literal rather than read from `models.json`: if a release ever moves the default endpoint,
 * this test must FAIL rather than quietly follow it, because the model picker would then be pointing somewhere
 * the user's server is not.
 */
const DEFAULT_ENDPOINT = "http://localhost:11434";
const defaultEndpointModels = await probe(DEFAULT_ENDPOINT);
const liveDefault = defaultEndpointModels.length > 0 ? test : test.skip;

if (available.length === 0) {
  console.log(`[ai] No Ollama server at ${BASE_URL}; the live suite is skipped.`);
} else {
  console.log(`[ai] Live Ollama at ${BASE_URL}, using ${model} (of ${available.length} installed).`);
}

describe("Ollama, live (spec §14.3)", () => {
  live("lists the models actually installed on this machine", async () => {
    const models = await createOllamaAdapter().listModels({
      baseUrl: BASE_URL,
      apiKey: null,
      signal: AbortSignal.timeout(10_000),
    });
    expect(models.length).toBeGreaterThan(0);
    expect(models).toContain(model);
  });

  live("returns a real reply and ends the turn", async () => {
    const chunks: string[] = [];
    await createOllamaAdapter().chat(
      {
        model,
        baseUrl: BASE_URL,
        apiKey: null,
        messages: [
          { role: "assistant", content: "You answer with a single word." },
          { role: "user", content: "Reply with exactly the word: banana" },
        ],
        signal: AbortSignal.timeout(120_000),
      },
      (text) => chunks.push(text),
    );

    // Content only. Incrementality is asserted by the next test, against a prompt long enough to have it: a
    // one-word answer legitimately arrives in a single chunk, so asserting both here made the streaming claim
    // depend on how many tokens the model happened to use (measured: exactly 1, and this test failed).
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(chunks.join("").toLowerCase()).toContain("banana");
  });

  /**
   * The assertion only a live server can make: a reply really does arrive in pieces, so the NDJSON decoding, the
   * carry across read boundaries and the done-detection all worked against real wire bytes rather than against a
   * fixture shaped the way the parser expects.
   */
  live("streams a long reply incrementally, in many chunks", async () => {
    const chunks: string[] = [];
    await createOllamaAdapter().chat(
      {
        model,
        baseUrl: BASE_URL,
        apiKey: null,
        messages: [{ role: "user", content: "Count from 1 to 20, one number per line. Numbers only." }],
        signal: AbortSignal.timeout(120_000),
      },
      (text) => chunks.push(text),
    );

    expect(chunks.length).toBeGreaterThan(1);
    const reply = chunks.join("");
    expect(reply).toContain("20");
    // No chunk is empty: the adapter drops empty content rather than forwarding keep-alive frames as text.
    expect(chunks.every((chunk) => chunk !== "")).toBe(true);
  });

  live("a real request aborts on Stop, mid-stream", async () => {
    const controller = new AbortController();
    const chunks: string[] = [];
    const finished = createOllamaAdapter().chat(
      {
        model,
        baseUrl: BASE_URL,
        apiKey: null,
        messages: [{ role: "user", content: "Count slowly from 1 to 500, one number per line." }],
        signal: controller.signal,
      },
      (text) => {
        chunks.push(text);
        // Abort as soon as the reply is genuinely under way, so this exercises a mid-stream teardown rather
        // than a cancellation that raced the connection.
        if (chunks.length === 3) controller.abort();
      },
    );

    await expect(finished).rejects.toThrow(AiRequestError);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
  });

  live("a model that does not exist is reported as modelNotFound, not as a generic failure", async () => {
    const error = (await createOllamaAdapter()
      .chat(
        {
          model: "definitely-not-a-real-model:v0",
          baseUrl: BASE_URL,
          apiKey: null,
          messages: [{ role: "user", content: "hi" }],
          signal: AbortSignal.timeout(30_000),
        },
        () => {},
      )
      .catch((thrown: unknown) => thrown)) as AiRequestError;

    expect(error).toBeInstanceOf(AiRequestError);
    expect(error.kind).toBe("modelNotFound");
  });

  live("a refused connection on a dead port is a network error", async () => {
    const error = (await createOllamaAdapter()
      .chat(
        {
          model,
          // A port nothing is listening on: the transport failure path, against a real socket.
          baseUrl: "http://127.0.0.1:1",
          apiKey: null,
          messages: [{ role: "user", content: "hi" }],
          signal: AbortSignal.timeout(10_000),
        },
        () => {},
      )
      .catch((thrown: unknown) => thrown)) as AiRequestError;

    expect(error.kind).toBe("network");
  });

  /**
   * TL-20 end to end against a real model (spec §14.2).
   *
   * An Explain Result request is an ordinary `ai.send` with spec §14.2's sentence and the rendered value as its
   * prompt, so what this proves that no fixture can is that the WHOLE assembled context -- the bundled system
   * prompt, the tab's code, the run's output and that prompt, in `buildMessages`' order -- is something a real
   * server accepts and answers, rather than a shape only JSLab's own stub has ever agreed to.
   */
  live("an Explain Result request is accepted by a real server and answered", async () => {
    const messages = buildMessages(
      {
        requestId: crypto.randomUUID(),
        tabId: "t1",
        prompt: "Explain why line 2 produces this result:\n\n6",
        code: "const total = [1, 2, 3].reduce((a, b) => a + b, 0);\ntotal;\n",
        language: "typescript",
        runtime: "bun",
        output: "6",
        history: [],
      },
      { includeOutput: true },
    );
    // Deterministic half, asserted before the network is involved: the code and the output really do ride the
    // request alongside the prompt, which is what "reuses the existing assembler" has to mean.
    const joined = messages.map((message) => message.content).join("\n");
    expect(joined).toContain("reduce");
    expect(joined).toContain("Explain why line 2 produces this result:");

    const chunks: string[] = [];
    await createOllamaAdapter().chat(
      { model, baseUrl: BASE_URL, apiKey: null, messages, signal: AbortSignal.timeout(120_000) },
      (text) => chunks.push(text),
    );
    // Content is the model's business; that it answered at all is this suite's.
    expect(chunks.join("").trim().length).toBeGreaterThan(0);
  });

  /**
   * TL-23's model list, end to end against a real server (spec §14.3).
   *
   * `AiModelListService` is unit-tested against a fake adapter, which proves its coalescing, caching and backoff
   * but deliberately never opens a socket. What only a real server can prove is that the rest of the Main-side
   * path holds together: a BLANK `ai.baseUrl.ollama` resolving through the manifest to a reachable endpoint, the
   * Keychain lookup resolving to no key, the adapter, and a real `/api/tags` body arriving as model ids the
   * picker can actually show. Those four have no fixture between them here.
   */
  liveDefault("the model list service reaches a real server through the manifest's default endpoint", async () => {
    const service = new AiModelListService({
      registry: createAdapterRegistry([createOllamaAdapter()]),
      // Blank base URL and blank model: stock settings, so the manifest default is what gets resolved.
      settings: { current: defaultSettings() },
      log: () => {},
    });

    const result = await service.list("ollama", false);

    expect(result.error).toBeNull();
    expect(result.detail).toBe("");
    // Every model the raw probe saw at that endpoint comes back through the service. Asserted this way rather
    // than by comparing arrays, so neither the de-duplication nor the server's ordering is baked in here.
    for (const name of defaultEndpointModels) expect(result.models).toContain(name);

    // A second look is served from the cache rather than from the server, which is what stops the AI tab from
    // re-asking a real provider every time it is opened.
    expect((await service.list("ollama", false)).models).toEqual(result.models);
  });
});
