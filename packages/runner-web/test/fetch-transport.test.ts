import { expect, test } from "bun:test";
import type { HostToWebMessage, WebToHostMessage } from "@jslab/rpc-schema";
import { type RunnerWebGlobal, startRunnerWeb } from "../src/bootstrap";

/**
 * Task 9b (ledger ruling R-M4-T13-FETCHWIRE-1): the **production** `browser-node` fetch transport.
 *
 * Every other test in this package drives `installFetchProxy` against a fake transport the test itself supplies.
 * That proved the proxy, and left the thing that was actually broken untested: nothing built a real transport, so
 * `web-entry.ts` called `startRunnerWeb()` with no arguments, `options.fetchTransport` was always undefined, and a
 * real `browser-node` page silently got a plain CORS-enforced `fetch`. These tests supply **no** transport -- the
 * one under test is the one `startRunnerWeb` builds for itself out of the host bridge.
 */

/** A page-shaped global with no `fetch` of its own: anything reaching the network here is a failure. */
function fakeGlobal(sent: WebToHostMessage[]): RunnerWebGlobal {
  return {
    setTimeout: setTimeout as unknown as RunnerWebGlobal["setTimeout"],
    clearTimeout: clearTimeout as unknown as RunnerWebGlobal["clearTimeout"],
    // A no-op interval: this file never needs a heartbeat, and a real one would outlive the test.
    setInterval: (() => 0) as unknown as RunnerWebGlobal["setInterval"],
    clearInterval: (() => {}) as unknown as RunnerWebGlobal["clearInterval"],
    addEventListener: () => {},
    removeEventListener: () => {},
    console: {},
    fetch: (() =>
      Promise.reject(
        new Error("the page's own fetch must never be used in browser-node"),
      )) as unknown as RunnerWebGlobal["fetch"],
    __electrobunSendToHost: (value: unknown) => sent.push((value as { message: WebToHostMessage }).message),
    // biome-ignore lint/suspicious/noExplicitAny: a stand-in global, exactly as handles.test.ts builds one
  } as any;
}

function start(runtime: "browser" | "browser-node") {
  const sent: WebToHostMessage[] = [];
  const g = fakeGlobal(sent);
  const handle = startRunnerWeb({ global: g, runtime });
  let seq = 0;
  const fromHost = (message: HostToWebMessage) =>
    (g.__jslabHostMessage as (m: unknown) => void)({ seq: ++seq, message });
  return { g, sent, handle, fromHost };
}

const encode = (text: string) => btoa(text);

test("browser-node fetch goes to the host over the bridge, with no transport supplied by the caller", async () => {
  const { g, sent, handle, fromHost } = start("browser-node");
  try {
    void (g.fetch as typeof fetch)("https://example.com/thing", { method: "POST", body: "hi" }).catch(() => {});
    // `fetch-proxy.ts`'s wrapper awaits `request.arrayBuffer()` before handing the request over.
    await Promise.resolve();
    await Promise.resolve();

    const request = sent.find((message) => message.type === "fetchRequest");
    expect(request).toMatchObject({ type: "fetchRequest", id: 1, url: "https://example.com/thing", method: "POST" });
    // The body crosses the JSON-only relay base64-encoded.
    expect(atob((request as { body: string }).body)).toBe("hi");
    void fromHost;
  } finally {
    handle.dispose();
  }
});

test("a streamed host reply becomes a real Response in the page", async () => {
  const { g, sent, handle, fromHost } = start("browser-node");
  try {
    const pending = (g.fetch as typeof fetch)("https://example.com/data");
    await Promise.resolve();
    await Promise.resolve();
    const id = (sent.find((message) => message.type === "fetchRequest") as { id: number }).id;

    fromHost({
      type: "fetchHead",
      id,
      status: 201,
      statusText: "Created",
      headers: [["content-type", "text/plain"]],
      url: "https://example.com/data",
    });
    fromHost({ type: "fetchChunk", id, data: encode("hello ") });
    fromHost({ type: "fetchChunk", id, data: encode("world") });
    fromHost({ type: "fetchEnd", id });

    const response = await pending;
    expect(response.status).toBe(201);
    expect(response.statusText).toBe("Created");
    expect(response.headers.get("content-type")).toBe("text/plain");
    expect(response.url).toBe("https://example.com/data");
    expect(await response.text()).toBe("hello world");
  } finally {
    handle.dispose();
  }
});

test("a host fetchError rejects the page's fetch instead of leaving it pending forever", async () => {
  const { g, sent, handle, fromHost } = start("browser-node");
  try {
    const pending = (g.fetch as typeof fetch)("https://example.com/nope");
    await Promise.resolve();
    await Promise.resolve();
    const id = (sent.find((message) => message.type === "fetchRequest") as { id: number }).id;

    fromHost({ type: "fetchError", id, message: "host said no" });

    await expect(pending).rejects.toThrow("host said no");
  } finally {
    handle.dispose();
  }
});

test("an aborted page fetch tells the host to cancel its own request", async () => {
  const { g, sent, handle } = start("browser-node");
  try {
    const controller = new AbortController();
    void (g.fetch as typeof fetch)("https://example.com/slow", { signal: controller.signal }).catch(() => {});
    await Promise.resolve();
    await Promise.resolve();
    const id = (sent.find((message) => message.type === "fetchRequest") as { id: number }).id;

    controller.abort();

    expect(sent).toContainEqual({ type: "fetchAbort", id });
  } finally {
    handle.dispose();
  }
});

/**
 * The defining refusal (spec §5.12): `browser` keeps the page's own CORS-enforced `fetch`. The wiring above must not
 * have quietly given every web tab a proxy -- so this asserts the host never hears a `fetchRequest` at all.
 */
test("the browser runtime still routes nothing through the host", async () => {
  const { g, sent, handle } = start("browser");
  try {
    await (g.fetch as typeof fetch)("https://example.com/").catch(() => {});
    await Promise.resolve();
    await Promise.resolve();
    expect(sent.some((message) => message.type === "fetchRequest")).toBe(false);
  } finally {
    handle.dispose();
  }
});
