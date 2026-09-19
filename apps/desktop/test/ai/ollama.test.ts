import { describe, expect, mock, test } from "bun:test";
import type { AiErrorKind } from "@jslab/rpc-schema";
import { createOllamaAdapter } from "../../src/main/ai/ollama";
import { AiRequestError } from "../../src/main/ai/provider";

const encoder = new TextEncoder();

function ndjsonResponse(chunks: string[], init: ResponseInit = {}): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, ...init });
}

const line = (content: string) => `${JSON.stringify({ message: { content } })}\n`;
const DONE = `${JSON.stringify({ done: true })}\n`;

interface Call {
  url: string;
  init: RequestInit;
}

function setup(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const doFetch = mock(async (input: string, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return await respond(call);
  });
  const adapter = createOllamaAdapter({ fetch: doFetch });
  return { adapter, calls };
}

const request = (overrides: Partial<Parameters<ReturnType<typeof createOllamaAdapter>["chat"]>[0]> = {}) => ({
  model: "qwen2.5:7b-instruct",
  baseUrl: "http://localhost:11434",
  apiKey: null as string | null,
  messages: [{ role: "user" as const, content: "hi" }],
  signal: new AbortController().signal,
  ...overrides,
});

describe("the Ollama adapter (spec §14.3)", () => {
  test("posts to /api/chat with streaming on, and reports the decoded text in order", async () => {
    const { adapter, calls } = setup(() => ndjsonResponse([line("Hel"), line("lo"), DONE]));
    const chunks: string[] = [];
    await adapter.chat(request(), (text) => chunks.push(text));

    expect(chunks.join("")).toBe("Hello");
    expect(calls[0]?.url).toBe("http://localhost:11434/api/chat");
    expect(calls[0]?.init.method).toBe("POST");
    const body = JSON.parse(String(calls[0]?.init.body)) as { model: string; stream: boolean };
    expect(body.model).toBe("qwen2.5:7b-instruct");
    // Without this the provider answers in one blocking shot and nothing streams at all.
    expect(body.stream).toBe(true);
  });

  /**
   * THE KEY SEAM. Ollama needs no key, which is exactly why this is pinned: the adapter is the shape the other
   * five providers plug into, and a build that "worked" while silently dropping `apiKey` would only be found out
   * by the first keyed provider.
   */
  test("sends the key as a bearer token when there is one, and no auth header when there is not", async () => {
    const withKey = setup(() => ndjsonResponse([DONE]));
    await withKey.adapter.chat(request({ apiKey: "a-test-token" }), () => {});
    // The length assertions matter: without them a request that was never made would satisfy the header checks
    // below vacuously, which is the failure mode an optional chain invites.
    expect(withKey.calls).toHaveLength(1);
    const keyed = (withKey.calls[0]?.init.headers ?? {}) as Record<string, string>;
    expect(keyed.authorization).toBe("Bearer a-test-token");

    const without = setup(() => ndjsonResponse([DONE]));
    await without.adapter.chat(request({ apiKey: null }), () => {});
    expect(without.calls).toHaveLength(1);
    const plain = (without.calls[0]?.init.headers ?? {}) as Record<string, string>;
    expect(plain.authorization).toBeUndefined();
    // The auth header is the ONLY difference: everything else about the request is identical either way.
    expect(plain["content-type"]).toBe("application/json");
  });

  test("a reply split across read boundaries mid-object is reassembled", async () => {
    // One JSON object delivered in three pieces, the split landing inside the object and inside a word.
    const whole = line("streamed");
    const { adapter } = setup(() => ndjsonResponse([whole.slice(0, 10), whole.slice(10, 20), whole.slice(20), DONE]));
    const chunks: string[] = [];
    await adapter.chat(request(), (text) => chunks.push(text));
    expect(chunks.join("")).toBe("streamed");
  });

  test("a body that ends before the provider says done is reported, not shown as a finished reply", async () => {
    const { adapter } = setup(() => ndjsonResponse([line("half an ans")]));
    await expect(adapter.chat(request(), () => {})).rejects.toThrow(/closed the connection before finishing/);
  });

  test("an error inside a 200 stream fails the turn", async () => {
    const { adapter } = setup(() => ndjsonResponse([line("ok"), `${JSON.stringify({ error: "model unloaded" })}\n`]));
    await expect(adapter.chat(request(), () => {})).rejects.toThrow(/model unloaded/);
  });

  test("a line that is not JSON is skipped rather than failing a healthy stream", async () => {
    const { adapter } = setup(() => ndjsonResponse([line("a"), "not json\n", line("b"), DONE]));
    const chunks: string[] = [];
    await adapter.chat(request(), (text) => chunks.push(text));
    expect(chunks.join("")).toBe("ab");
  });

  test("HTTP failures are classified the way spec §14.3 names them", async () => {
    const cases: [number, string, AiErrorKind][] = [
      [401, "{}", "auth"],
      [429, "{}", "rateLimit"],
      [404, JSON.stringify({ error: "model 'nope' not found" }), "modelNotFound"],
      [400, JSON.stringify({ error: "prompt exceeds context length" }), "contextTooLong"],
      [500, "{}", "http"],
    ];
    for (const [status, body, kind] of cases) {
      const { adapter } = setup(() => new Response(body, { status }));
      const error = (await adapter.chat(request(), () => {}).catch((thrown: unknown) => thrown)) as AiRequestError;
      expect(error).toBeInstanceOf(AiRequestError);
      expect({ status, kind: error.kind }).toEqual({ status, kind });
    }
  });

  test("a transport failure becomes a network error rather than escaping raw", async () => {
    const { adapter } = setup(() => {
      throw new TypeError("connection refused");
    });
    const error = (await adapter.chat(request(), () => {}).catch((thrown: unknown) => thrown)) as AiRequestError;
    expect(error.kind).toBe("network");
    expect(error.detail).toContain("connection refused");
  });

  /**
   * Stop must end the HTTP REQUEST, not merely stop reading it (spec §14.1).
   *
   * Asserted MID-STREAM, which is the only moment it means anything: `chat` detaches its abort relay in a
   * `finally`, so a signal aborted after the turn has already finished is deliberately inert. An earlier version
   * of this test aborted after `await chat(...)` resolved and failed for exactly that reason -- it was asserting
   * a property the adapter does not have, and should not have.
   */
  test("aborting mid-stream tears the request down and fails the turn", async () => {
    const controller = new AbortController();
    let push: (text: string) => void = () => {};
    const { adapter, calls } = setup((call) => {
      const body = new ReadableStream<Uint8Array>({
        start(streamController) {
          push = (text) => streamController.enqueue(encoder.encode(text));
          // Mirrors real `fetch`: aborting the signal errors the body stream. Without this the fake would keep
          // the stream open after the abort and the adapter would sit there until its stall timeout.
          call.init.signal?.addEventListener("abort", () => {
            streamController.error(new DOMException("The operation was aborted.", "AbortError"));
          });
        },
      });
      return new Response(body, { status: 200 });
    });

    const chunks: string[] = [];
    const finished = adapter.chat(request({ signal: controller.signal }), (text) => chunks.push(text));
    push(line("partial "));
    await Bun.sleep(5);

    const passed = calls[0]?.init.signal as AbortSignal;
    expect(passed).toBeInstanceOf(AbortSignal);
    // Still streaming: the request is live, so nothing has been torn down yet.
    expect(passed.aborted).toBe(false);
    expect(chunks).toEqual(["partial "]);

    controller.abort();
    // The adapter chains its own controller to the caller's, so what fetch was handed is aborted too.
    expect(passed.aborted).toBe(true);
    await expect(finished).rejects.toThrow(AiRequestError);
  });

  test("listModels reads /api/tags and returns the model names", async () => {
    const { adapter, calls } = setup(
      () => new Response(JSON.stringify({ models: [{ name: "qwen2.5:7b-instruct" }, { name: "mistral:latest" }, {}] })),
    );
    const models = await adapter.listModels({
      baseUrl: "http://localhost:11434",
      apiKey: null,
      signal: new AbortController().signal,
    });
    expect(models).toEqual(["qwen2.5:7b-instruct", "mistral:latest"]);
    expect(calls[0]?.url).toBe("http://localhost:11434/api/tags");
  });

  test("the adapter declares that it needs no key, which is what the registry checks", () => {
    expect(createOllamaAdapter().needsApiKey).toBe(false);
    expect(createOllamaAdapter().id).toBe("ollama");
  });
});
