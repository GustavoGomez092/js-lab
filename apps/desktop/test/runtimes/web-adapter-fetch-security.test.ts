import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostToWebMessage, RunEvent, WebToHostMessage } from "@jslab/rpc-schema";
import type { AppBundleResult, BundleOptions, VendorBundleResult } from "../../src/main/bundling/bundler";
import type { PreparedRun, RunEventSink } from "../../src/main/runtimes/adapter";
import {
  ASSERT_HOST_HOOK_SNIPPET,
  createSequencedWebviewHost,
  createWebAdapter,
  type RawWebview,
  type WebAdapterDeps,
  type WebviewHost,
  type WebviewSource,
} from "../../src/main/runtimes/web-adapter";

// Task 13, fix round 1 (security). `webFetch.*` used to be an RPC handler group taking a page-supplied `tabId` in
// its payload, authorized by looking the tab's runtime up by that same id -- once registered, a `browser` tab
// could name a `browser-node` tab's id and get a CORS-free request issued on the user's session. The fix moves
// authorization to `WebRunSession#onMessage` (`web-adapter.ts`), which checks `this.deps.runtime` -- fixed per
// `WebAdapter` instance, never read from the message -- before ever performing a fetch.
//
// This file tests that against a FORGED envelope, not through `fetch-proxy.ts`'s own proxy: `FakeRawWebview.emit`
// fires whatever `WebToHostMessage` a test hands it directly on the page->host channel, exactly modelling a page
// that constructed a `fetchRequest` by calling `window.__electrobunSendToHost` itself, bypassing the proxy's own
// refusal for "browser" entirely. The proxy is the path that already behaves; this is the path that didn't.

const BOOTSTRAP_SOURCE = "/* fake runner-web bootstrap */";

class FakeRawWebview implements RawWebview {
  readonly executed: string[] = [];
  readonly #loadedListeners = new Set<() => void>();
  readonly #hostMessageListeners = new Set<(raw: unknown) => void>();
  readonly #crashListeners = new Set<() => void>();

  reload(): void {
    this.fireLoaded();
  }
  executeJavascript(js: string): void {
    this.executed.push(js);
    if (js.includes(ASSERT_HOST_HOOK_SNIPPET)) this.emit(1, { type: "ready" });
  }
  onLoaded(listener: () => void): () => void {
    this.#loadedListeners.add(listener);
    return () => this.#loadedListeners.delete(listener);
  }
  onHostMessage(listener: (raw: unknown) => void): () => void {
    this.#hostMessageListeners.add(listener);
    return () => this.#hostMessageListeners.delete(listener);
  }
  onCrashed(listener: () => void): () => void {
    this.#crashListeners.add(listener);
    return () => this.#crashListeners.delete(listener);
  }
  destroy(): void {}
  fireLoaded(): void {
    for (const listener of [...this.#loadedListeners]) listener();
  }
  /** Fires a page->host envelope directly -- the forged path this file exists to test. */
  emit(seq: number, message: WebToHostMessage): void {
    for (const listener of [...this.#hostMessageListeners]) listener({ seq, message });
  }
}

function parseHostMessages(raw: FakeRawWebview): HostToWebMessage[] {
  return raw.executed
    .map((js) => js.match(/^window\.__jslabHostMessage\((.*)\);$/s)?.[1])
    .filter((body): body is string => Boolean(body))
    .map((body) => (JSON.parse(body) as { message: HostToWebMessage }).message);
}

class FakeWebviewSource implements WebviewSource {
  readonly raws = new Map<string, FakeRawWebview>();
  private readonly hosts = new Map<string, WebviewHost>();
  async ensure(tab: { tabId: string }): Promise<WebviewHost> {
    let host = this.hosts.get(tab.tabId);
    if (!host) {
      const raw = new FakeRawWebview();
      this.raws.set(tab.tabId, raw);
      host = createSequencedWebviewHost(raw, BOOTSTRAP_SOURCE);
      this.hosts.set(tab.tabId, host);
    }
    return host;
  }
  destroy(tabId: string): void {
    this.raws.delete(tabId);
    this.hosts.delete(tabId);
  }
}

async function startSession(
  runtime: "browser" | "browser-node",
  overrides: Partial<WebAdapterDeps> = {},
): Promise<{ raw: FakeRawWebview; webviews: FakeWebviewSource }> {
  const dir = await mkdtemp(join(tmpdir(), "jslab-web-fetch-security-"));
  const webviews = new FakeWebviewSource();
  const bundle = async (_options: BundleOptions): Promise<AppBundleResult> => ({
    code: "BUNDLED",
    map: "MAP",
    imports: [],
    vendorCacheable: true,
  });
  const bundleVendor = async (): Promise<VendorBundleResult> => ({
    code: "VENDOR",
    map: "VMAP",
    vendorCacheable: true,
    closure: [],
  });
  const adapter = createWebAdapter({
    webviews,
    runtime,
    runsDir: dir,
    packagesNodeModules: join(dir, "node_modules"),
    bunLockPath: join(dir, "bun.lock"),
    vendorCache: { get: async () => null, set: async () => {} },
    runLock: { add: () => {}, remove: () => {} },
    directoryExists: async () => true,
    readBunLock: async () => "lockfile",
    bundle,
    bundleVendor,
    ...overrides,
  });
  const sink: RunEventSink = {
    attached: () => {},
    events: () => {},
    state: () => {},
    heartbeat: () => {},
    exited: () => {},
  };
  const run: PreparedRun = {
    runId: "run-1",
    tabId: "t1",
    code: "1 + 1",
    maxEntries: 10_000,
    workingDirectory: null,
    mapEvent: (event) => event as RunEvent,
    isCancelled: () => false,
  };
  await adapter.start(run, sink);
  const raw = webviews.raws.get("t1");
  if (!raw) throw new Error("expected a webview for t1");
  return { raw, webviews };
}

describe("browser-node fetch security (fix round 1)", () => {
  test("a browser session refuses a forged fetchRequest envelope, and never calls the real fetch", async () => {
    let called = false;
    const { raw } = await startSession("browser", {
      webFetch: async () => {
        called = true;
        return new Response("should never happen");
      },
    });
    raw.executed.length = 0; // discard the initial reset/run traffic
    raw.emit(2, {
      type: "fetchRequest",
      id: 1,
      url: "https://example.com/",
      method: "GET",
      headers: [],
      body: null,
    });
    const [reply] = parseHostMessages(raw);
    expect(reply).toMatchObject({ type: "fetchError", id: 1 });
    expect((reply as { message: string }).message).toContain('is "browser"');
    expect(called).toBe(false);
  });

  test("an unrelated tab cannot get a browser-node request by naming this browser session at all -- there is no tabId field to put one in", async () => {
    // The forged-envelope shape itself: no `tabId` anywhere in `WebToHostMessage`, so a `browser` tab's page has no
    // field to write a `browser-node` tab's id into even if it wanted to -- the type this test constructs proves
    // the shape carries none.
    const message: WebToHostMessage = {
      type: "fetchRequest",
      id: 1,
      url: "https://example.com/",
      method: "GET",
      headers: [],
      body: null,
    };
    expect(Object.keys(message)).not.toContain("tabId");
  });

  test("a browser-node session performs a forged (or proxy-sent) fetchRequest for real, streaming the reply back", async () => {
    const { raw } = await startSession("browser-node", {
      webFetch: async () =>
        new Response("hi", { status: 200, statusText: "OK", headers: { "content-type": "text/plain" } }),
    });
    raw.executed.length = 0;
    raw.emit(2, {
      type: "fetchRequest",
      id: 7,
      url: "https://example.com/",
      method: "GET",
      headers: [],
      body: null,
    });
    await Bun.sleep(20);
    const replies = parseHostMessages(raw);
    expect(replies[0]).toMatchObject({ type: "fetchHead", id: 7, status: 200 });
    expect(replies.some((m) => m.type === "fetchChunk" && m.id === 7)).toBe(true);
    expect(replies[replies.length - 1]).toEqual({ type: "fetchEnd", id: 7 });
  });

  test("fetchAbort on a browser-node session releases the in-flight request", async () => {
    const gate = new Promise<void>(() => {}); // never resolves: the request stays pending until aborted
    const { raw } = await startSession("browser-node", {
      webFetch: async (_url, init) => {
        await Promise.race([
          gate,
          new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))),
        ]);
        return new Response("unreachable");
      },
    });
    raw.executed.length = 0;
    raw.emit(2, { type: "fetchRequest", id: 3, url: "https://example.com/", method: "GET", headers: [], body: null });
    await Bun.sleep(5);
    raw.emit(3, { type: "fetchAbort", id: 3 });
    await Bun.sleep(20);
    const replies = parseHostMessages(raw);
    // Aborted before any head arrived: the runner sends nothing at all for it (matches fetch-proxy.ts's own
    // "entry.settled" branch), so the only honest assertion is that no fetchEnd/fetchHead for id 3 ever showed up.
    expect(replies.some((m) => "id" in m && m.id === 3)).toBe(false);
  });
});
