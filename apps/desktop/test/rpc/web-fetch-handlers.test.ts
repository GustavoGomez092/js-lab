import { describe, expect, mock, test } from "bun:test";
import { createRedactor } from "../../src/main/logging/redact";
import { createWebFetchRunner, type WebFetchRunnerDeps } from "../../src/main/rpc/web-fetch-handlers";

// Fix round 1 (Task 13): this module no longer has an identity to authorize (no `tabId`, no `runtimeOf`) -- one
// runner is built per already-authorized `WebRunSession` (`../../src/main/runtimes/web-adapter.ts`), which is
// where the `"browser-node"` gate now lives, tested against a forged envelope in
// `test/runtimes/web-adapter-fetch-security.test.ts`. This file covers what's still this module's own job:
// streaming, abort, redaction, and refusing a malformed/unroutable request instead of dropping or hanging it.

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

function setup(overrides: Partial<WebFetchRunnerDeps> = {}) {
  const events: SentEvent[] = [];
  const record =
    (type: SentEvent["type"]) =>
    (payload: Record<string, unknown>): void => {
      events.push({ type, payload });
    };
  const log = mock((_message: string, _detail?: unknown) => {});
  const deps: WebFetchRunnerDeps = {
    send: {
      head: record("head") as WebFetchRunnerDeps["send"]["head"],
      chunk: record("chunk") as WebFetchRunnerDeps["send"]["chunk"],
      end: record("end") as WebFetchRunnerDeps["send"]["end"],
      error: record("error") as WebFetchRunnerDeps["send"]["error"],
    },
    redact: createRedactor(),
    log,
    ...overrides,
  };
  return { deps, events, log, runner: createWebFetchRunner(deps) };
}

function request(url: string, extra: { headers?: [string, string][]; method?: string; body?: string | null } = {}) {
  return { url, method: extra.method ?? "GET", headers: extra.headers ?? [], body: extra.body ?? null };
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

describe("WebFetchRunner.request", () => {
  test("streams a reply back to the page: head, then chunks, then end", async () => {
    const gate = deferred();
    const server = gatedServer(gate.promise);
    try {
      const { runner, events } = setup();
      runner.request(1, request(server.url.href));
      gate.resolve();
      await waitUntil(() => events.some((event) => event.type === "end"), "the reply to end");

      // How many chunks the two writes arrive in is the network's business (they may coalesce when nothing gates
      // them); the shape -- head, then chunks, then end -- is this runner's.
      expect(events[0]?.type).toBe("head");
      expect(events[events.length - 1]?.type).toBe("end");
      expect(events.slice(1, -1).every((event) => event.type === "chunk")).toBe(true);
      const head = events[0]?.payload;
      expect(head?.status).toBe(201);
      expect(head?.statusText).toBe("Created");
      expect(head?.id).toBe(1);
      expect(head?.headers).toContainEqual(["content-type", "text/plain"]);
      const body = events
        .filter((event) => event.type === "chunk")
        .map((event) => chunkText(String(event.payload.data)))
        .join("");
      expect(body).toBe("first-second");
      expect(runner.pending()).toBe(0);
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
      const { runner, events } = setup();
      runner.request(1, request(server.url.href));
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
      const { runner, events } = setup();
      runner.request(1, request(server.url.href));
      await waitUntil(() => events.some((event) => event.type === "end"), "the reply to end");
      expect(runner.pending()).toBe(0);
    } finally {
      server.stop(true);
    }
  });

  test("a malformed request envelope is refused, never fetched", () => {
    const fetched: string[] = [];
    const { runner, events } = setup({
      fetch: (url) => {
        fetched.push(url);
        return Promise.resolve(new Response("never"));
      },
    });
    // @ts-expect-error -- deliberately malformed, the same shape a forged or buggy envelope could carry.
    runner.request(1, { url: "https://example.test/" });
    expect(fetched).toEqual([]);
    expect(events).toEqual([{ type: "error", payload: { id: 1, message: "Malformed fetch request envelope." } }]);
  });

  test("a failed request reports an error to the page instead of throwing", async () => {
    const { runner, events } = setup({
      fetch: () => Promise.reject(new Error("connect ECONNREFUSED")),
    });
    expect(() => runner.request(1, request("https://example.test/down"))).not.toThrow();
    await waitUntil(() => events.some((event) => event.type === "error"), "the error to reach the page");
    expect(String(events[0]?.payload.message)).toContain("ECONNREFUSED");
    expect(runner.pending()).toBe(0);
  });

  test("what is logged about a request is redacted, and so is an error before it crosses back", async () => {
    const { runner, events, log } = setup({
      fetch: () => Promise.reject(new Error("rejected Authorization: Bearer ghp_0123456789abcdefghijklmnopqr")),
    });
    runner.request(
      1,
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

describe("WebFetchRunner.abort", () => {
  test("cancels the Main-side request and releases its in-flight entry", async () => {
    let captured: AbortSignal | undefined;
    const { runner } = setup({
      fetch: (_url, init) => {
        captured = init?.signal ?? undefined;
        return new Promise<Response>(() => {});
      },
    });
    runner.request(1, request("https://example.test/slow"));
    await waitUntil(() => captured !== undefined, "the request to start");
    expect(captured?.aborted).toBe(false);
    expect(runner.pending()).toBe(1);

    runner.abort(1);
    expect(captured?.aborted).toBe(true);
    expect(runner.pending()).toBe(0);
  });

  test("stops a stream in flight: nothing more reaches the page after the abort", async () => {
    const gate = deferred();
    const server = gatedServer(gate.promise);
    try {
      const { runner, events } = setup();
      runner.request(1, request(server.url.href));
      await waitUntil(() => events.some((event) => event.type === "chunk"), "the first chunk");

      runner.abort(1);
      const delivered = events.length;
      gate.resolve();
      await Bun.sleep(50);
      expect(events.length).toBe(delivered);
      expect(runner.pending()).toBe(0);
    } finally {
      server.stop(true);
    }
  });

  test("an abort for an unknown request is a safe no-op", () => {
    const { runner, events } = setup();
    expect(() => runner.abort(99)).not.toThrow();
    expect(events).toEqual([]);
    expect(runner.pending()).toBe(0);
  });

  test("abortAll releases every in-flight request at once", async () => {
    const signals: AbortSignal[] = [];
    const { runner } = setup({
      fetch: (_url, init) => {
        if (init?.signal) signals.push(init.signal);
        return new Promise<Response>(() => {});
      },
    });
    runner.request(1, request("https://example.test/a"));
    runner.request(2, request("https://example.test/b"));
    await waitUntil(() => signals.length === 2, "both requests to start");
    runner.abortAll();
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(runner.pending()).toBe(0);
  });
});

describe("defence in depth (the identity gate itself lives in WebRunSession now)", () => {
  // Fix round 1, F1 (carried over from Task 12). A payload that parses far enough to be routable is answered,
  // never dropped.
  test("a routable request with an unsupported scheme is answered with an error, never dropped", async () => {
    const fetched: string[] = [];
    const { runner, events } = setup({
      fetch: (url) => {
        fetched.push(url);
        return Promise.resolve(new Response("must not be fetched"));
      },
    });

    runner.request(1, request("file:///etc/passwd"));
    await waitUntil(() => events.some((event) => event.type === "error"), "the refusal to reach the page");

    expect(fetched).toEqual([]);
    expect(String(events[0]?.payload.message)).toContain("file:");
    expect(runner.pending()).toBe(0);
  });

  // Fix round 1, M3 (carried over from Task 12). Ids are proxy-generated and monotonic, so a repeat means a
  // misbehaving page or relay; the request already in flight must not be silently orphaned by it.
  test("a duplicate in-flight id is refused and leaves the first request running", async () => {
    let started = 0;
    let captured: AbortSignal | undefined;
    const { runner, events } = setup({
      fetch: (_url, init) => {
        started += 1;
        captured = init?.signal ?? undefined;
        return new Promise<Response>(() => {});
      },
    });

    runner.request(1, request("https://example.test/first"));
    await waitUntil(() => started === 1, "the first request to start");
    runner.request(1, request("https://example.test/second"));
    await waitUntil(() => events.some((event) => event.type === "error"), "the duplicate to be refused");

    expect(started).toBe(1);
    expect(captured?.aborted).toBe(false);
    expect(runner.pending()).toBe(1);
  });
});
