import { expect, test } from "bun:test";
import {
  type FetchHostEvent,
  type FetchProxyGlobal,
  type FetchTransport,
  installFetchProxy,
  type ProxiedRequest,
} from "../src/fetch-proxy";
import { HandleTracker, installHandleTracking } from "../src/handles";

// bun:test has no DOM, and the host side does not exist here either: the transport is a fake the test drives by
// hand (the same approach handles.test.ts takes for every other host API), so every assertion below is about the
// proxy's own behaviour rather than about a real webview or a real Main process.

const decoder = new TextDecoder();
const text = (bytes: Uint8Array | undefined) => (bytes ? decoder.decode(bytes) : "");

async function waitUntil(condition: () => boolean, label: string, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(1);
  }
}

function fakeTransport() {
  const requests: { id: number; request: ProxiedRequest }[] = [];
  const aborted: number[] = [];
  const listeners = new Set<(event: FetchHostEvent) => void>();
  const transport: FetchTransport = {
    request(id, request) {
      requests.push({ id, request });
    },
    abort(id) {
      aborted.push(id);
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    transport,
    requests,
    aborted,
    subscriptions: () => listeners.size,
    deliver(event: FetchHostEvent) {
      for (const listener of [...listeners]) listener(event);
    },
    async firstId(): Promise<number> {
      await waitUntil(() => requests.length > 0, "the request to reach the host");
      return requests[0]?.id ?? 0;
    },
  };
}

/** A page global whose `fetch` fails loudly: nothing in a `browser-node` page may reach the real network. */
function pageGlobal(): FetchProxyGlobal {
  return { fetch: () => Promise.reject(new Error("the native fetch must not be called in browser-node")) };
}

// Spec section 5.12: in `browser`, fetch IS the page's own fetch, with CORS enforced. A request a real page would
// fail must fail here the same way, so the proxy must leave the global completely alone -- not wrap it, not even
// subscribe to the host.
test("the browser runtime keeps the page's own fetch: nothing is proxied", () => {
  const host = fakeTransport();
  const native = (() => Promise.resolve(new Response("native"))) as FetchProxyGlobal["fetch"];
  const g: FetchProxyGlobal = { fetch: native };
  const installed = installFetchProxy({ runtime: "browser", transport: host.transport, global: g });
  expect(installed).toBe(false);
  expect(g.fetch).toBe(native);
  expect(host.subscriptions()).toBe(0);
  expect(host.requests).toEqual([]);
});

test("browser-node sends the request to the host with its method, url, headers and body", async () => {
  const host = fakeTransport();
  const g = pageGlobal();
  expect(installFetchProxy({ runtime: "browser-node", transport: host.transport, global: g })).toBe(true);

  const pending = g.fetch?.("https://example.test/api", {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "hello",
  });
  const id = await host.firstId();
  const sent = host.requests[0]?.request;
  expect(sent?.method).toBe("POST");
  expect(sent?.url).toBe("https://example.test/api");
  expect(sent?.headers).toContainEqual(["content-type", "text/plain"]);
  expect(sent?.body).toBe(btoa("hello"));

  host.deliver({ type: "head", id, status: 200, statusText: "OK", headers: [], url: "https://example.test/api" });
  host.deliver({ type: "end", id });
  await pending;
});

test("the reply keeps its status, statusText, headers and ok", async () => {
  const host = fakeTransport();
  const g = pageGlobal();
  installFetchProxy({ runtime: "browser-node", transport: host.transport, global: g });

  const pending = g.fetch?.("https://example.test/missing");
  const id = await host.firstId();
  host.deliver({
    type: "head",
    id,
    status: 404,
    statusText: "Not Found",
    headers: [["content-type", "application/json"]],
    url: "https://example.test/missing",
  });
  host.deliver({ type: "end", id });

  const response = await pending;
  expect(response?.status).toBe(404);
  expect(response?.statusText).toBe("Not Found");
  expect(response?.ok).toBe(false);
  expect(response?.headers.get("content-type")).toBe("application/json");
  expect(response?.url).toBe("https://example.test/missing");
});

// The point of this one: `read()` resolves while the response is still open. A proxy that buffered the whole body
// and handed it over at the end could not pass it -- the first read would not settle until "end" was delivered.
test("the body streams: a chunk is readable before the reply has ended", async () => {
  const host = fakeTransport();
  const g = pageGlobal();
  installFetchProxy({ runtime: "browser-node", transport: host.transport, global: g });

  const pending = g.fetch?.("https://example.test/stream");
  const id = await host.firstId();
  host.deliver({ type: "head", id, status: 200, statusText: "OK", headers: [], url: "https://example.test/stream" });
  const response = await pending;

  const reader = response?.body?.getReader();
  if (!reader) throw new Error("the proxied response has no readable body");
  host.deliver({ type: "chunk", id, data: btoa("first-") });
  expect(text((await reader.read()).value)).toBe("first-");

  host.deliver({ type: "chunk", id, data: btoa("second") });
  expect(text((await reader.read()).value)).toBe("second");

  host.deliver({ type: "end", id });
  expect((await reader.read()).done).toBe(true);
});

test("the whole body is reassembled across chunks", async () => {
  const host = fakeTransport();
  const g = pageGlobal();
  installFetchProxy({ runtime: "browser-node", transport: host.transport, global: g });

  const pending = g.fetch?.("https://example.test/stream");
  const id = await host.firstId();
  host.deliver({ type: "head", id, status: 200, statusText: "OK", headers: [], url: "https://example.test/stream" });
  host.deliver({ type: "chunk", id, data: btoa("first-") });
  host.deliver({ type: "chunk", id, data: btoa("second") });
  host.deliver({ type: "end", id });

  const response = await pending;
  expect(await response?.text()).toBe("first-second");
});

test("an aborted controller cancels the host-side request and rejects with an AbortError", async () => {
  const host = fakeTransport();
  const g = pageGlobal();
  installFetchProxy({ runtime: "browser-node", transport: host.transport, global: g });

  const controller = new AbortController();
  const pending = g.fetch?.("https://example.test/slow", { signal: controller.signal });
  const id = await host.firstId();
  controller.abort();

  expect(host.aborted).toEqual([id]);
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
});

// The leak this guards: one tracked handle per aborted request. installHandleTracking wraps whatever `fetch` the
// global has, so the proxy has to be installed first -- and its promise has to actually reject on abort, or the
// tracker's own `finally` never runs and the page stays "active" forever.
test("aborting a proxied request releases the page's handle tracker", async () => {
  const host = fakeTransport();
  const g = pageGlobal() as FetchProxyGlobal & Record<string, unknown>;
  g.setTimeout = setTimeout;
  g.clearTimeout = clearTimeout;
  g.setInterval = setInterval;
  g.clearInterval = clearInterval;
  installFetchProxy({ runtime: "browser-node", transport: host.transport, global: g });
  const tracker = new HandleTracker(() => {});
  installHandleTracking(tracker, g);

  const controller = new AbortController();
  const pending = (g.fetch as (input: unknown, init?: RequestInit) => Promise<Response>)("https://example.test/slow", {
    signal: controller.signal,
  });
  await host.firstId();
  expect(tracker.count).toBe(1);

  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  await waitUntil(() => tracker.count === 0, "the handle tracker to release the aborted request");
  expect(tracker.count).toBe(0);
});

// Fix round 1, F1. The runner page is loaded from `views://runner-web/index.html` (spec section 5.12) and the
// request is normalized through a real `Request`, so an ordinary `fetch("/api/data")` resolves to exactly the url
// below. It used to be sent to Main, fail Main's http(s) gate, be dropped by `message()`, and leave the promise
// pending forever. The page is the only layer that can *guarantee* a failure, because a payload Main cannot route
// leaves Main nothing to reply to -- so the scheme is checked here, before anything is sent.
test("an unsupported scheme rejects with a TypeError before anything is sent", async () => {
  const host = fakeTransport();
  const g = pageGlobal();
  installFetchProxy({ runtime: "browser-node", transport: host.transport, global: g });

  // What `fetch("/api/data")` becomes once resolved against the runner page's own url.
  await expect(g.fetch?.("views://runner-web/api/data")).rejects.toMatchObject({ name: "TypeError" });
  await expect(g.fetch?.("file:///etc/passwd")).rejects.toMatchObject({ name: "TypeError" });
  expect(host.requests).toEqual([]);
});

// Fix round 1, Q1. `data:` needs no network and no proxy, and its payload is already in the page's memory, so
// routing it through Main would withhold a capability both neighbouring runtimes have for no gain.
test("a data: or blob: url is served by the page's own fetch and never reaches the host", async () => {
  const host = fakeTransport();
  const served: string[] = [];
  const g: FetchProxyGlobal = {
    fetch: (input) => {
      served.push(String(input));
      return Promise.resolve(new Response("served natively"));
    },
  };
  installFetchProxy({ runtime: "browser-node", transport: host.transport, global: g });

  expect(await (await g.fetch?.("data:text/plain,hello"))?.text()).toBe("served natively");
  // A literal blob: url rather than URL.createObjectURL: only the scheme is ever inspected, so registering a real
  // blob would buy nothing and leave a live registration behind for a body this test never reads.
  const blobUrl = "blob:https://example.test/6f1a2b3c";
  expect(await (await g.fetch?.(blobUrl))?.text()).toBe("served natively");

  expect(served).toEqual(["data:text/plain,hello", blobUrl]);
  expect(host.requests).toEqual([]);
});

test("a host-reported failure rejects the request the way a network error does", async () => {
  const host = fakeTransport();
  const g = pageGlobal();
  installFetchProxy({ runtime: "browser-node", transport: host.transport, global: g });

  const pending = g.fetch?.("https://example.test/down");
  const id = await host.firstId();
  host.deliver({ type: "error", id, message: "connection refused" });

  await expect(pending).rejects.toMatchObject({ name: "TypeError", message: "connection refused" });
});
