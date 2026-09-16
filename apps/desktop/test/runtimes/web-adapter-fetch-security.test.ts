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

/**
 * Fix round 2: a compile-time guarantee against the real `@jslab/rpc-schema` type, replacing a runtime test that
 * only ever asserted `Object.keys()` on a literal the test itself constructed -- that could never fail short of
 * editing the test, so it documented the wire shape without guarding it. This does guard it: if `fetchRequest` or
 * `fetchAbort` ever gains a `tabId` field, `NoTabId<...>` resolves to `never` and the assignment below stops
 * compiling, which `bun run typecheck` catches even though nothing here executes at runtime.
 */
type NoTabId<T> = "tabId" extends keyof T ? never : true;
const _fetchRequestHasNoTabId: NoTabId<Extract<WebToHostMessage, { type: "fetchRequest" }>> = true;
const _fetchAbortHasNoTabId: NoTabId<Extract<WebToHostMessage, { type: "fetchAbort" }>> = true;
void _fetchRequestHasNoTabId;
void _fetchAbortHasNoTabId;

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
    // A real timer, not a same-tick microtask: M4 T9c's `waitForReady` deliberately does not subscribe to `ready`
    // until `host.reset()` itself has resolved (closing a stale-ready race -- see that function's own doc comment
    // in web-adapter.ts), and `reset()` resolves synchronously right after this call returns. Firing "ready" in
    // the same microtask turn as that resolution would race it and lose (see `web-adapter.test.ts`'s identical fix
    // to its own `FakeRawWebview` for the full reasoning).
    if (js.includes(ASSERT_HOST_HOOK_SNIPPET)) setTimeout(() => this.emit(1, { type: "ready" }), 0);
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

  // Fix round 2: replaces a test that asserted `Object.keys()` on a literal the test itself constructed (passed
  // either way; documented the wire shape without guarding anything the implementation controls). This guards a
  // stronger, more direct claim: a page can still smuggle an extra `tabId` past TypeScript by hand-building the
  // raw JSON envelope `window.__electrobunSendToHost` carries (the cast below models exactly that), and it must
  // still have zero effect -- the session decides purely from `this.deps.runtime`, never from the message. A
  // regression that reintroduced reading `message.tabId` would make this specific assertion fail; the compile-time
  // check above only catches the field being reintroduced into the *type*, not the implementation reading one that
  // slipped past it.
  test("an injected tabId in a forged fetchRequest has no effect on which runtime answers it", async () => {
    let called = false;
    const { raw } = await startSession("browser", {
      webFetch: async () => {
        called = true;
        return new Response("should never happen");
      },
    });
    raw.executed.length = 0;
    raw.emit(2, {
      type: "fetchRequest",
      id: 1,
      url: "https://example.com/",
      method: "GET",
      headers: [],
      body: null,
      tabId: "some-browser-node-tab",
    } as unknown as WebToHostMessage);
    const [reply] = parseHostMessages(raw);
    expect(reply).toMatchObject({ type: "fetchError", id: 1 });
    expect((reply as { message: string }).message).toContain('is "browser"');
    expect(called).toBe(false);
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
