import { describe, expect, mock, test } from "bun:test";
import { createRedactor } from "../../src/main/logging/redact";
import { createWebFetchHandlers, type WebFetchHandlerDeps } from "../../src/main/rpc/web-fetch-handlers";

const encoder = new TextEncoder();
const chunkText = (data: string) => Buffer.from(data, "base64").toString("utf8");

interface SentEvent {
  type: "head" | "chunk" | "end" | "error";
  payload: Record<string, unknown>;
}

async function waitUntil(condition: () => boolean, label: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(1);
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function setup(overrides: Partial<WebFetchHandlerDeps> = {}) {
  const events: SentEvent[] = [];
  const record =
    (type: SentEvent["type"]) =>
    (payload: Record<string, unknown>): void => {
      events.push({ type, payload });
    };
  const log = mock((_message: string, _detail?: unknown) => {});
  const deps: WebFetchHandlerDeps = {
    send: {
      head: record("head") as WebFetchHandlerDeps["send"]["head"],
      chunk: record("chunk") as WebFetchHandlerDeps["send"]["chunk"],
      end: record("end") as WebFetchHandlerDeps["send"]["end"],
      error: record("error") as WebFetchHandlerDeps["send"]["error"],
    },
    redact: createRedactor(),
    log,
    ...overrides,
  };
  return { deps, events, log, handlers: createWebFetchHandlers(deps) };
}

function request(url: string, extra: { headers?: [string, string][]; method?: string; body?: string | null } = {}) {
  return {
    tabId: "t1",
    id: 1,
    request: { url, method: extra.method ?? "GET", headers: extra.headers ?? [], body: extra.body ?? null },
  };
}

/** A server that writes one chunk, then waits for the test before writing the second. */
function gatedServer(gate: Promise<void>, headers: Record<string, string> = {}) {
  return Bun.serve({
    port: 0,
    fetch: () =>
      new Response(
        new ReadableStream({
          async start(controller) {
            controller.enqueue(encoder.encode("first-"));
            await gate;
            try {
              controller.enqueue(encoder.encode("second"));
              controller.close();
            } catch {
              // the client went away: nothing left to write
            }
          },
        }),
        { status: 201, statusText: "Created", headers: { "content-type": "text/plain", ...headers } },
      ),
  });
}

describe("webFetch.request", () => {
  test("streams a reply back to the page: head, then chunks, then end", async () => {
    const gate = deferred();
    const server = gatedServer(gate.promise);
    try {
      const { handlers, events } = setup();
      handlers.messages["webFetch.request"](request(server.url.href));
      gate.resolve();
      await waitUntil(() => events.some((event) => event.type === "end"), "the reply to end");

      // How many chunks the two writes arrive in is the network's business (they may coalesce when nothing gates
      // them); the shape -- head, then chunks, then end -- is this handler's.
      expect(events[0]?.type).toBe("head");
      expect(events[events.length - 1]?.type).toBe("end");
      expect(events.slice(1, -1).every((event) => event.type === "chunk")).toBe(true);
      const head = events[0]?.payload;
      expect(head?.status).toBe(201);
      expect(head?.statusText).toBe("Created");
      expect(head?.tabId).toBe("t1");
      expect(head?.id).toBe(1);
      expect(head?.headers).toContainEqual(["content-type", "text/plain"]);
      const body = events
        .filter((event) => event.type === "chunk")
        .map((event) => chunkText(String(event.payload.data)))
        .join("");
      expect(body).toBe("first-second");
      expect(handlers.pending()).toBe(0);
    } finally {
      server.stop(true);
    }
  });

  // The buffering test: the second chunk cannot exist until this test releases the gate, and the gate is only
  // released after the first chunk has already crossed back. An implementation that awaited the whole body before
  // sending anything would deadlock here rather than quietly pass.
  test("the body arrives progressively: the first chunk crosses back before the server writes the last", async () => {
    const gate = deferred();
    const server = gatedServer(gate.promise);
    try {
      const { handlers, events } = setup();
      handlers.messages["webFetch.request"](request(server.url.href));
      await waitUntil(() => events.some((event) => event.type === "chunk"), "the first chunk");

      expect(chunkText(String(events.find((event) => event.type === "chunk")?.payload.data))).toBe("first-");
      expect(events.some((event) => event.type === "end")).toBe(false);

      gate.resolve();
      await waitUntil(() => events.some((event) => event.type === "end"), "the reply to end");
      expect(events.filter((event) => event.type === "chunk")).toHaveLength(2);
    } finally {
      server.stop(true);
    }
  });

  test("a completed request releases its in-flight entry", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("done") });
    try {
      const { handlers, events } = setup();
      handlers.messages["webFetch.request"](request(server.url.href));
      await waitUntil(() => events.some((event) => event.type === "end"), "the reply to end");
      expect(handlers.pending()).toBe(0);
    } finally {
      server.stop(true);
    }
  });

  test("an invalid payload is logged and dropped, never fetched", () => {
    const fetched: string[] = [];
    const { handlers, events, log } = setup({
      fetch: (url) => {
        fetched.push(url);
        return Promise.resolve(new Response("never"));
      },
    });
    handlers.messages["webFetch.request"]({ tabId: "", id: 1, request: { url: "https://example.test/" } });
    handlers.messages["webFetch.request"]({ tabId: "t1", id: 0, request: null });
    // Not a network capability: a file: url would make this bridge an unrestricted file reader for page code.
    handlers.messages["webFetch.request"](request("file:///etc/passwd"));
    expect(fetched).toEqual([]);
    expect(events).toEqual([]);
    expect(log).toHaveBeenCalled();
  });

  test("a failed request reports an error to the page instead of throwing", async () => {
    const { handlers, events } = setup({
      fetch: () => Promise.reject(new Error("connect ECONNREFUSED")),
    });
    expect(() => handlers.messages["webFetch.request"](request("https://example.test/down"))).not.toThrow();
    await waitUntil(() => events.some((event) => event.type === "error"), "the error to reach the page");
    expect(String(events[0]?.payload.message)).toContain("ECONNREFUSED");
    expect(handlers.pending()).toBe(0);
  });

  test("what is logged about a request is redacted, and so is an error before it crosses back", async () => {
    const { handlers, events, log } = setup({
      fetch: () => Promise.reject(new Error("rejected Authorization: Bearer ghp_0123456789abcdefghijklmnopqr")),
    });
    handlers.messages["webFetch.request"](
      request("https://example.test/v1?key=AIzaB1234567890123456789012345678901234", {
        headers: [["authorization", "Bearer ghp_0123456789abcdefghijklmnopqr"]],
      }),
    );
    const logged = log.mock.calls.map((call) => `${String(call[0])} ${String(call[1])}`).join("\n");
    expect(logged).toContain("[REDACTED]");
    expect(logged).not.toContain("ghp_0123456789abcdefghijklmnopqr");
    expect(logged).not.toContain("AIzaB1234567890123456789012345678901234");

    await waitUntil(() => events.some((event) => event.type === "error"), "the error to reach the page");
    expect(String(events[0]?.payload.message)).not.toContain("ghp_0123456789abcdefghijklmnopqr");
    expect(String(events[0]?.payload.message)).toContain("[REDACTED]");
  });
});

describe("webFetch.abort", () => {
  test("cancels the Main-side request and releases its in-flight entry", async () => {
    let captured: AbortSignal | undefined;
    const { handlers } = setup({
      fetch: (_url, init) => {
        captured = init?.signal ?? undefined;
        return new Promise<Response>(() => {});
      },
    });
    handlers.messages["webFetch.request"](request("https://example.test/slow"));
    await waitUntil(() => captured !== undefined, "the request to start");
    expect(captured?.aborted).toBe(false);
    expect(handlers.pending()).toBe(1);

    handlers.messages["webFetch.abort"]({ tabId: "t1", id: 1 });
    expect(captured?.aborted).toBe(true);
    expect(handlers.pending()).toBe(0);
  });

  test("stops a stream in flight: nothing more reaches the page after the abort", async () => {
    const gate = deferred();
    const server = gatedServer(gate.promise);
    try {
      const { handlers, events } = setup();
      handlers.messages["webFetch.request"](request(server.url.href));
      await waitUntil(() => events.some((event) => event.type === "chunk"), "the first chunk");

      handlers.messages["webFetch.abort"]({ tabId: "t1", id: 1 });
      const delivered = events.length;
      gate.resolve();
      await Bun.sleep(50);
      expect(events.length).toBe(delivered);
      expect(handlers.pending()).toBe(0);
    } finally {
      server.stop(true);
    }
  });

  test("an abort for an unknown request is a safe no-op", () => {
    const { handlers, events } = setup();
    expect(() => handlers.messages["webFetch.abort"]({ tabId: "t1", id: 99 })).not.toThrow();
    expect(events).toEqual([]);
    expect(handlers.pending()).toBe(0);
  });
});
