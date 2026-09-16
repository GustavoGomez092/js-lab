import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EncodedValue, HostToWebMessage, RunEvent, RunState, WebToHostMessage } from "@jslab/rpc-schema";
import {
  type AppBundleResult,
  type BundleOptions,
  joinVendorAndApp,
  type VendorBundleResult,
} from "../../src/main/bundling/bundler";
import { hashBunLock, vendorCacheKey } from "../../src/main/bundling/vendor-cache";
import type { PreparedRun, RunEventSink, RunHandle, TabRunContext } from "../../src/main/runtimes/adapter";
import { WorkingDirectoryMismatchError } from "../../src/main/runtimes/adapter";
import {
  ASSERT_HOST_HOOK_SNIPPET,
  createSequencedWebviewHost,
  createWebAdapter,
  type RawWebview,
  type WebAdapterDeps,
  type WebviewHost,
  type WebviewSource,
} from "../../src/main/runtimes/web-adapter";

const BOOTSTRAP_SOURCE = "/* fake runner-web bootstrap */";

/** A `RawWebview`-shaped fake fully controlled by the test: no real Electrobun webview is ever created. */
class FakeRawWebview implements RawWebview {
  readonly executed: string[] = [];
  reloadCount = 0;
  destroyed = false;
  /** Default: reload() synchronously fires onLoaded, and the injected bootstrap synchronously sends "ready" --
   * most tests don't care about this timing and just want a working end-to-end round trip. */
  autoLoad = true;
  autoReady = true;
  readonly #loadedListeners = new Set<() => void>();
  readonly #hostMessageListeners = new Set<(raw: unknown) => void>();
  readonly #crashListeners = new Set<() => void>();

  reload(): void {
    this.reloadCount++;
    if (this.autoLoad) this.fireLoaded();
  }

  executeJavascript(js: string): void {
    this.executed.push(js);
    // A real timer, not a same-tick microtask: M4 T9c's re-review of `waitForReady` established that it must not
    // subscribe to `ready` until `host.reset()` itself has resolved (closing a stale-ready race -- see
    // `waitForReady`'s own doc comment), and `reset()` resolves synchronously right after this call returns. Firing
    // "ready" in the same microtask turn as that resolution would race it, sometimes losing the message before
    // `waitForReady`'s listener is even attached; a macrotask guarantees the genuine round trip this simulates
    // (page -> host, across a real IPC boundary) is never mistaken for something narrower.
    if (this.autoReady && js.includes(ASSERT_HOST_HOOK_SNIPPET)) setTimeout(() => this.emit(1, { type: "ready" }), 0);
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

  destroy(): void {
    this.destroyed = true;
  }

  fireLoaded(): void {
    for (const listener of [...this.#loadedListeners]) listener();
  }

  emit(seq: number, message: WebToHostMessage): void {
    for (const listener of [...this.#hostMessageListeners]) listener({ seq, message });
  }

  crash(): void {
    for (const listener of [...this.#crashListeners]) listener();
  }
}

/** Extracts the `{seq, message}` envelope out of an `executeJavascript` call built by `createSequencedWebviewHost`. */
function parseHostMessageCall(js: string): { seq: number; message: HostToWebMessage } {
  const match = js.match(/^window\.__jslabHostMessage\((.*)\);$/s);
  const body = match?.[1];
  if (!body) throw new Error(`not a host message call: ${js}`);
  return JSON.parse(body);
}

class FakeWebviewSource implements WebviewSource {
  readonly raws = new Map<string, FakeRawWebview>();
  readonly hosts = new Map<string, WebviewHost>();
  ensuredTabIds: string[] = [];
  destroyedTabIds: string[] = [];

  async ensure(tab: TabRunContext): Promise<WebviewHost> {
    this.ensuredTabIds.push(tab.tabId);
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
    this.destroyedTabIds.push(tabId);
    this.raws.get(tabId)?.destroy();
    this.raws.delete(tabId);
    this.hosts.delete(tabId);
  }
}

interface Harness {
  webviews: FakeWebviewSource;
  raw: FakeRawWebview;
  handle: RunHandle;
  events: RunEvent[];
  states: { state: RunState; activeHandles?: number }[];
  /** Task 15 (spec §5.12, EX-35): every `sink.audio()` call the session made, in order. */
  audioEvents: boolean[];
  exitedCalls: () => number;
  locks: Set<string>;
  vendorSets: { key: string; chunk: { code: string; map: string } }[];
  dir: string;
}

const identityMap = (event: unknown): RunEvent => event as RunEvent;
const LOCK_TEXT = "lockfile-contents";

async function createHarness(
  overrides: Partial<Omit<WebAdapterDeps, "webviews" | "runLock" | "runsDir">> = {},
  runOverrides: Partial<PreparedRun> = {},
): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "jslab-web-adapter-"));
  const webviews = new FakeWebviewSource();
  const locks = new Set<string>();
  const vendorSets: Harness["vendorSets"] = [];
  const bundle =
    overrides.bundle ??
    (async (_options: BundleOptions): Promise<AppBundleResult> => ({
      code: "BUNDLED",
      map: "MAP",
      imports: ["react"],
      vendorCacheable: true,
    }));
  const bundleVendor =
    overrides.bundleVendor ??
    (async (): Promise<VendorBundleResult> => ({ code: "VENDOR", map: "VMAP", vendorCacheable: true, closure: [] }));
  const adapter = createWebAdapter({
    webviews,
    runtime: "browser",
    runsDir: dir,
    packagesNodeModules: join(dir, "node_modules"),
    bunLockPath: join(dir, "bun.lock"),
    vendorCache: {
      get: async () => null,
      set: async (key, chunk) => {
        vendorSets.push({ key, chunk });
      },
    },
    runLock: {
      add: (id) => locks.add(id),
      remove: (id) => locks.delete(id),
    },
    directoryExists: async () => true,
    readBunLock: async () => LOCK_TEXT,
    ...overrides,
    bundle,
    bundleVendor,
  });
  const events: RunEvent[] = [];
  const states: Harness["states"] = [];
  const audioEvents: boolean[] = [];
  let exitedCalls = 0;
  const sink: RunEventSink = {
    attached: () => {},
    events: (batch) => events.push(...batch),
    state: (state, activeHandles) => states.push({ state, activeHandles }),
    heartbeat: () => {},
    exited: () => {
      exitedCalls++;
    },
    audio: (active) => audioEvents.push(active),
  };
  const run: PreparedRun = {
    runId: "run-1",
    tabId: "t1",
    code: "1 + 1",
    maxEntries: 10_000,
    workingDirectory: null,
    mapEvent: identityMap,
    isCancelled: () => false,
    ...runOverrides,
  };
  const handle = await adapter.start(run, sink);
  const raw = webviews.raws.get("t1");
  if (!raw) throw new Error("expected a webview to have been created for t1");
  return { webviews, raw, handle, events, states, audioEvents, exitedCalls: () => exitedCalls, locks, vendorSets, dir };
}

describe("WebAdapter", () => {
  test("start() resets the page, bundles the entry, and sends run with the bundled code", async () => {
    const h = await createHarness();
    try {
      expect(h.raw.reloadCount).toBe(1);
      expect(h.raw.executed[0]).toContain(ASSERT_HOST_HOOK_SNIPPET);
      expect(h.raw.executed[0]).toContain(BOOTSTRAP_SOURCE);

      const runCall = parseHostMessageCall(h.raw.executed.at(-1) as string);
      expect(runCall).toEqual({
        seq: 1,
        message: {
          type: "run",
          runId: "run-1",
          code: joinVendorAndApp("VENDOR", "BUNDLED"),
          settings: { maxEntries: 10_000 },
          muted: false,
        },
      });

      expect(await readFile(join(h.dir, "t1", "entry-run-1.mjs"), "utf8")).toBe("1 + 1");
      expect(h.locks.has("run-1")).toBe(true);

      const expectedKey = vendorCacheKey(hashBunLock(LOCK_TEXT), ["react"], "browser");
      // The cache stores the VENDOR chunk -- never the app chunk, which is what would make a later run stale.
      expect(h.vendorSets).toEqual([{ key: expectedKey, chunk: { code: "VENDOR", map: "VMAP" } }]);
    } finally {
      await rm(h.dir, { recursive: true, force: true });
    }
  });

  test("M1: start() prunes stale entry files from previous runs, keeping only the latest", async () => {
    const h = await createHarness();
    try {
      const adapter = createWebAdapter({
        webviews: h.webviews,
        runtime: "browser",
        runsDir: h.dir,
        packagesNodeModules: join(h.dir, "node_modules"),
        bunLockPath: join(h.dir, "bun.lock"),
        vendorCache: { get: async () => null, set: async () => {} },
        bundleVendor: async () => ({ code: "VENDOR", map: "VMAP", vendorCacheable: true, closure: [] }),
        runLock: { add: () => {}, remove: () => {} },
        directoryExists: async () => true,
        readBunLock: async () => LOCK_TEXT,
        bundle: async () => ({ code: "BUNDLED-2", map: "MAP", imports: ["react"], vendorCacheable: true }),
      });
      const run2: PreparedRun = {
        runId: "run-2",
        tabId: "t1",
        code: "2 + 2",
        maxEntries: 10_000,
        workingDirectory: null,
        mapEvent: identityMap,
        isCancelled: () => false,
      };
      await adapter.start(run2, {
        attached: () => {},
        events: () => {},
        state: () => {},
        heartbeat: () => {},
        exited: () => {},
      });
      await Bun.sleep(10); // cleanupEntries is fire-and-forget
      const entries = (await readdir(join(h.dir, "t1"))).filter((name) => name.startsWith("entry-"));
      expect(entries).toEqual(["entry-run-2.mjs"]);
    } finally {
      await rm(h.dir, { recursive: true, force: true });
    }
  });

  test("start() fails closed when the working directory no longer exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jslab-web-adapter-"));
    try {
      const webviews = new FakeWebviewSource();
      let bundleCalls = 0;
      const adapter = createWebAdapter({
        webviews,
        runtime: "browser",
        runsDir: dir,
        packagesNodeModules: join(dir, "node_modules"),
        bunLockPath: join(dir, "bun.lock"),
        vendorCache: { get: async () => null, set: async () => {} },
        bundleVendor: async () => ({ code: "VENDOR", map: "VMAP", vendorCacheable: true, closure: [] }),
        runLock: { add: () => {}, remove: () => {} },
        directoryExists: async () => false,
        bundle: async () => {
          bundleCalls++;
          return { code: "x", map: "", imports: [], vendorCacheable: true };
        },
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
        workingDirectory: "/gone",
        mapEvent: identityMap,
        isCancelled: () => false,
      };
      await expect(adapter.start(run, sink)).rejects.toThrow(WorkingDirectoryMismatchError);
      // Fix round 1 (I1): the check now runs immediately before bundle() -- after ensure()/reset()/the ready round
      // trip and the entry write, not before them -- so the webview *was* ensured and reset, but bundle() was
      // never reached.
      expect(webviews.ensuredTabIds).toEqual(["t1"]);
      expect(webviews.raws.get("t1")?.reloadCount).toBe(1);
      expect(bundleCalls).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("I1: a working directory deleted during the reset/ready round trip is caught, not missed", async () => {
    // The directory "exists" only until the page's bootstrap injection happens (simulating deletion during the
    // reset/ready window) -- the OLD placement (checked as the very first statement of start()) would have seen it
    // as present and proceeded; the fixed placement (immediately before bundle()) must not.
    const dir = await mkdtemp(join(tmpdir(), "jslab-web-adapter-"));
    try {
      const webviews = new FakeWebviewSource();
      let dirGone = false;
      let bundleCalls = 0;
      const adapter = createWebAdapter({
        webviews,
        runtime: "browser",
        runsDir: dir,
        packagesNodeModules: join(dir, "node_modules"),
        bunLockPath: join(dir, "bun.lock"),
        vendorCache: { get: async () => null, set: async () => {} },
        bundleVendor: async () => ({ code: "VENDOR", map: "VMAP", vendorCacheable: true, closure: [] }),
        runLock: { add: () => {}, remove: () => {} },
        directoryExists: async () => !dirGone,
        bundle: async () => {
          bundleCalls++;
          return { code: "x", map: "", imports: [], vendorCacheable: true };
        },
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
        workingDirectory: "/work",
        mapEvent: identityMap,
        isCancelled: () => false,
      };
      const raw = new FakeRawWebview();
      raw.autoReady = false;
      webviews.raws.set("t1", raw);
      webviews.hosts.set("t1", createSequencedWebviewHost(raw, BOOTSTRAP_SOURCE));
      const startPromise = adapter.start(run, sink);
      await Bun.sleep(0);
      expect(raw.reloadCount).toBe(1); // reset() already happened; the directory still "existed" at that point
      dirGone = true; // simulate the deletion happening during the reset/ready window
      raw.emit(1, { type: "ready" });
      await expect(startPromise).rejects.toThrow(WorkingDirectoryMismatchError);
      expect(bundleCalls).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("each run resets the webview and the bridge sequence restarts at 1", async () => {
    const h = await createHarness();
    try {
      const first = parseHostMessageCall(h.raw.executed.at(-1) as string);
      expect(first.seq).toBe(1);

      // A second run against the same tab: the same persistent webview is reused, but reset() again.
      const adapter = createWebAdapter({
        webviews: h.webviews,
        runtime: "browser",
        runsDir: h.dir,
        packagesNodeModules: join(h.dir, "node_modules"),
        bunLockPath: join(h.dir, "bun.lock"),
        vendorCache: { get: async () => null, set: async () => {} },
        bundleVendor: async () => ({ code: "VENDOR", map: "VMAP", vendorCacheable: true, closure: [] }),
        runLock: { add: () => {}, remove: () => {} },
        directoryExists: async () => true,
        readBunLock: async () => LOCK_TEXT,
        bundle: async () => ({ code: "BUNDLED-2", map: "MAP", imports: ["react"], vendorCacheable: true }),
      });
      const run2: PreparedRun = {
        runId: "run-2",
        tabId: "t1",
        code: "2 + 2",
        maxEntries: 10_000,
        workingDirectory: null,
        mapEvent: identityMap,
        isCancelled: () => false,
      };
      await adapter.start(run2, {
        attached: () => {},
        events: () => {},
        state: () => {},
        heartbeat: () => {},
        exited: () => {},
      });

      expect(h.raw.reloadCount).toBe(2);
      const second = parseHostMessageCall(h.raw.executed.at(-1) as string);
      expect(second).toEqual({
        seq: 1,
        message: {
          type: "run",
          runId: "run-2",
          code: joinVendorAndApp("VENDOR", "BUNDLED-2"),
          settings: { maxEntries: 10_000 },
          muted: false,
        },
      });
    } finally {
      await rm(h.dir, { recursive: true, force: true });
    }
  });

  test("stop() escalates to kill (destroy+recreate the webview) after the grace period when the page never acknowledges", async () => {
    const h = await createHarness({ stopGraceMs: 30 });
    try {
      void h.handle.stop();
      const stopCall = parseHostMessageCall(h.raw.executed.at(-1) as string);
      expect(stopCall).toEqual({ seq: 2, message: { type: "stop" } });
      expect(h.raw.destroyed).toBe(false);
      await Bun.sleep(80);
      expect(h.raw.destroyed).toBe(true);
      expect(h.webviews.destroyedTabIds).toEqual(["t1"]);
      expect(h.locks.has("run-1")).toBe(false);
      expect(h.exitedCalls()).toBe(1);
      // Fix round 1 (C1): the run must be reported "killed", not left stuck at "stopping" -- RunCoordinator.stop()
      // sets "stopping" and then relies entirely on the adapter to report a terminal state; #checkHeartbeats only
      // watches "evaluating"/"settled", so a state never reported here is never corrected either.
      expect(h.states.at(-1)).toEqual({ state: "killed", activeHandles: undefined });
    } finally {
      await rm(h.dir, { recursive: true, force: true });
    }
  });

  test("stop() does not escalate once the page acknowledges stopped, and the webview is left alive", async () => {
    const h = await createHarness({ stopGraceMs: 30 });
    try {
      void h.handle.stop();
      h.raw.emit(2, { type: "state", runId: "run-1", state: "stopped", activeHandles: 0 });
      expect(h.states.at(-1)).toEqual({ state: "stopped", activeHandles: 0 });
      expect(h.raw.destroyed).toBe(false);
      await Bun.sleep(80); // past the 30ms grace period: no escalation should fire.
      expect(h.states.filter((s) => s.state === "killed")).toEqual([]);
      expect(h.raw.destroyed).toBe(false);
      expect(h.exitedCalls()).toBe(1);
    } finally {
      await rm(h.dir, { recursive: true, force: true });
    }
  });

  test("kill() destroys and recreates the webview immediately", async () => {
    const h = await createHarness();
    try {
      h.handle.kill();
      expect(h.raw.destroyed).toBe(true);
      expect(h.webviews.destroyedTabIds).toEqual(["t1"]);
      expect(h.exitedCalls()).toBe(1);
      // Fix round 1 (C1): explicit Kill also reports "killed" from the adapter itself now, not only as a side
      // effect of RunCoordinator.kill() setting it independently.
      expect(h.states.at(-1)).toEqual({ state: "killed", activeHandles: undefined });
      await Bun.sleep(10); // the fire-and-forget recreate is a microtask away
      expect(h.webviews.ensuredTabIds.length).toBeGreaterThan(1);
    } finally {
      await rm(h.dir, { recursive: true, force: true });
    }
  });

  test("expand() resolves the page's reply, and resolves null once the webview exits with one pending", async () => {
    const h = await createHarness();
    try {
      const value: EncodedValue = { t: "number", v: "42" };
      const pending = h.handle.expand("h1");
      expect(parseHostMessageCall(h.raw.executed.at(-1) as string)).toEqual({
        seq: 2,
        message: { type: "expand", reqId: 1, handleId: "h1" },
      });
      h.raw.emit(3, { type: "expanded", reqId: 1, value });
      expect(await pending).toEqual(value);

      const pendingOnExit = h.handle.expand("h2");
      h.raw.crash();
      expect(await pendingOnExit).toBeNull();
      expect(h.exitedCalls()).toBe(1);
      expect(h.states.at(-1)).toEqual({ state: "failed", activeHandles: undefined });
      expect(h.events.at(-1)?.kind).toBe("error");
    } finally {
      await rm(h.dir, { recursive: true, force: true });
    }
  });

  // Task 15 (spec §5.12, EX-35): mute() forwards straight to the page (page-lifetime, not run-scoped -- Main
  // never needs to know whether anything is currently playing), and an inbound "audio" message relays to
  // sink.audio() exactly like "state" relays to sink.state().
  test("mute() sends a mute message to the page, and an audio message from the page relays to sink.audio()", async () => {
    const h = await createHarness();
    try {
      h.handle.mute?.(true);
      expect(parseHostMessageCall(h.raw.executed.at(-1) as string)).toEqual({
        seq: 2,
        message: { type: "mute", muted: true },
      });

      h.raw.emit(3, { type: "audio", active: true });
      h.raw.emit(4, { type: "audio", active: false });
      expect(h.audioEvents).toEqual([true, false]);
    } finally {
      await rm(h.dir, { recursive: true, force: true });
    }
  });

  test("dispose() destroys the tab's webview", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jslab-web-adapter-"));
    try {
      const webviews = new FakeWebviewSource();
      const adapter = createWebAdapter({
        webviews,
        runtime: "browser-node",
        runsDir: dir,
        packagesNodeModules: join(dir, "node_modules"),
        bunLockPath: join(dir, "bun.lock"),
        vendorCache: { get: async () => null, set: async () => {} },
        bundleVendor: async () => ({ code: "VENDOR", map: "VMAP", vendorCacheable: true, closure: [] }),
        runLock: { add: () => {}, remove: () => {} },
      });
      await adapter.prepare({ tabId: "t1", workingDirectory: null });
      const raw = webviews.raws.get("t1");
      expect(raw).toBeDefined();
      await adapter.dispose("t1");
      expect(webviews.destroyedTabIds).toEqual(["t1"]);
      expect(raw?.destroyed).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("C2: start() fails the run, rather than hanging forever, when the page never reports ready", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jslab-web-adapter-"));
    try {
      const webviews = new FakeWebviewSource();
      const adapter = createWebAdapter({
        webviews,
        runtime: "browser",
        runsDir: dir,
        packagesNodeModules: join(dir, "node_modules"),
        bunLockPath: join(dir, "bun.lock"),
        vendorCache: { get: async () => null, set: async () => {} },
        bundleVendor: async () => ({ code: "VENDOR", map: "VMAP", vendorCacheable: true, closure: [] }),
        runLock: { add: () => {}, remove: () => {} },
        webviewReadyTimeoutMs: 30,
        bundle: async () => ({ code: "x", map: "", imports: [], vendorCacheable: true }),
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
        mapEvent: identityMap,
        isCancelled: () => false,
      };
      const raw = new FakeRawWebview();
      raw.autoReady = false; // the page never sends "ready"
      webviews.raws.set("t1", raw);
      webviews.hosts.set("t1", createSequencedWebviewHost(raw, BOOTSTRAP_SOURCE));
      await expect(adapter.start(run, sink)).rejects.toThrow(/never reported ready/);
      // The stuck webview is discarded so the tab's next run gets a genuinely fresh one.
      expect(webviews.destroyedTabIds).toEqual(["t1"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("M4 T9c: a stale 'ready' from the tab's previous page does not satisfy a later run's readiness wait", async () => {
    // A verified finding from an automated PR review (CodeRabbit on PR #3), confirmed by reading `waitForReady`
    // directly rather than taking the claim on faith: it used to subscribe to `host.onMessage` *before* calling
    // `host.reset()`, so nothing stopped a "ready" still in flight from the tab's *previous* page from satisfying a
    // wait it does not belong to. The SAME persistent webview is reset() again on every run on that tab (Task 8's
    // invariant), and `WebToHostMessage` carries no generation/epoch of its own to tell "this reload's ready" apart
    // from "the last one's, delayed in transit". This drives that race directly: a "ready" for run 2 arrives before
    // run 2's own page has actually reloaded, and must not let the run proceed against the stale realm.
    const dir = await mkdtemp(join(tmpdir(), "jslab-web-adapter-"));
    try {
      const webviews = new FakeWebviewSource();
      const raw = new FakeRawWebview();
      raw.autoLoad = false;
      raw.autoReady = false;
      webviews.raws.set("t1", raw);
      webviews.hosts.set("t1", createSequencedWebviewHost(raw, BOOTSTRAP_SOURCE));
      const adapter = createWebAdapter({
        webviews,
        runtime: "browser",
        runsDir: dir,
        packagesNodeModules: join(dir, "node_modules"),
        bunLockPath: join(dir, "bun.lock"),
        vendorCache: { get: async () => null, set: async () => {} },
        bundleVendor: async () => ({ code: "VENDOR", map: "VMAP", vendorCacheable: true, closure: [] }),
        runLock: { add: () => {}, remove: () => {} },
        bundle: async () => ({ code: "x", map: "", imports: [], vendorCacheable: true }),
      });
      const sink: RunEventSink = {
        attached: () => {},
        events: () => {},
        state: () => {},
        heartbeat: () => {},
        exited: () => {},
      };
      const run1: PreparedRun = {
        runId: "run-1",
        tabId: "t1",
        code: "1 + 1",
        maxEntries: 10_000,
        workingDirectory: null,
        mapEvent: identityMap,
        isCancelled: () => false,
      };

      // Run 1 completes normally, driven by hand, leaving the persistent webview's realm loaded and alive.
      const start1 = adapter.start(run1, sink);
      await Bun.sleep(0);
      raw.fireLoaded();
      await Bun.sleep(0); // let the post-reset() subscription attach before the genuine "ready" arrives
      raw.emit(1, { type: "ready" });
      await start1;
      raw.emit(2, { type: "state", runId: "run-1", state: "stopped", activeHandles: 0 });
      expect(raw.destroyed).toBe(false); // a graceful stop never destroys the webview (decision 1)

      // Run 2 begins on the SAME webview/host. Its own page has not reloaded yet (raw.fireLoaded() not called
      // again below) when a "ready" -- indistinguishable on the wire from a genuine one -- arrives: a straggler
      // from run 1's page, still in flight when this reset() superseded it.
      const run2: PreparedRun = { ...run1, runId: "run-2" };
      const start2 = adapter.start(run2, sink);
      await Bun.sleep(0);
      expect(raw.reloadCount).toBe(2); // run 2's own reset() has requested a reload...
      raw.emit(3, { type: "ready" }); // ...but this "ready" arrives before that reload actually completed.

      // Race start2 against a short real timer: if the stale message wrongly satisfied the wait, start2 resolves
      // well within this window, without run 2's own page ever having reloaded.
      const raced = await Promise.race([
        start2.then(() => "resolved" as const),
        new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 50)),
      ]);
      expect(raced).toBe("pending"); // must still be waiting for run 2's OWN ready, not the stale one

      // Finish run 2 for real: its own reload, then its own ready.
      raw.fireLoaded();
      await Bun.sleep(0);
      raw.emit(4, { type: "ready" });
      await start2;
      expect(raw.executed.some((js) => js.includes('"type":"run"'))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("C2: start() fails the run when the webview crashes during the reset/ready window", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jslab-web-adapter-"));
    try {
      const webviews = new FakeWebviewSource();
      const adapter = createWebAdapter({
        webviews,
        runtime: "browser",
        runsDir: dir,
        packagesNodeModules: join(dir, "node_modules"),
        bunLockPath: join(dir, "bun.lock"),
        vendorCache: { get: async () => null, set: async () => {} },
        bundleVendor: async () => ({ code: "VENDOR", map: "VMAP", vendorCacheable: true, closure: [] }),
        runLock: { add: () => {}, remove: () => {} },
        bundle: async () => ({ code: "x", map: "", imports: [], vendorCacheable: true }),
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
        mapEvent: identityMap,
        isCancelled: () => false,
      };
      const raw = new FakeRawWebview();
      raw.autoReady = false;
      webviews.raws.set("t1", raw);
      webviews.hosts.set("t1", createSequencedWebviewHost(raw, BOOTSTRAP_SOURCE));
      const startPromise = adapter.start(run, sink);
      await Bun.sleep(0);
      expect(raw.reloadCount).toBe(1); // reset() already in flight, awaiting ready
      raw.crash();
      await expect(startPromise).rejects.toThrow(/exited before it reported ready/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("M2: a run started immediately after a graceful Stop resets the sequence to 1, on the same webview", async () => {
    const h = await createHarness({ stopGraceMs: 500 });
    try {
      void h.handle.stop();
      h.raw.emit(2, { type: "state", runId: "run-1", state: "stopped", activeHandles: 0 });
      expect(h.raw.destroyed).toBe(false); // graceful stop never destroys the webview (decision 1)

      const adapter = createWebAdapter({
        webviews: h.webviews,
        runtime: "browser",
        runsDir: h.dir,
        packagesNodeModules: join(h.dir, "node_modules"),
        bunLockPath: join(h.dir, "bun.lock"),
        vendorCache: { get: async () => null, set: async () => {} },
        bundleVendor: async () => ({ code: "VENDOR", map: "VMAP", vendorCacheable: true, closure: [] }),
        runLock: { add: () => {}, remove: () => {} },
        directoryExists: async () => true,
        readBunLock: async () => LOCK_TEXT,
        bundle: async () => ({ code: "AFTER-STOP", map: "MAP", imports: ["react"], vendorCacheable: true }),
      });
      const run2: PreparedRun = {
        runId: "run-2",
        tabId: "t1",
        code: "3 + 3",
        maxEntries: 10_000,
        workingDirectory: null,
        mapEvent: identityMap,
        isCancelled: () => false,
      };
      await adapter.start(run2, {
        attached: () => {},
        events: () => {},
        state: () => {},
        heartbeat: () => {},
        exited: () => {},
      });

      expect(h.webviews.raws.get("t1")).toBe(h.raw); // same webview, not recreated
      expect(h.raw.reloadCount).toBe(2);
      expect(parseHostMessageCall(h.raw.executed.at(-1) as string)).toEqual({
        seq: 1,
        message: {
          type: "run",
          runId: "run-2",
          code: joinVendorAndApp("VENDOR", "AFTER-STOP"),
          settings: { maxEntries: 10_000 },
          muted: false,
        },
      });
    } finally {
      await rm(h.dir, { recursive: true, force: true });
    }
  });

  test("M2: a run started immediately after Kill resets the sequence to 1, on the recreated webview", async () => {
    const h = await createHarness();
    try {
      const originalRaw = h.raw;
      h.handle.kill();
      expect(originalRaw.destroyed).toBe(true);
      // kill()'s fire-and-forget recreate runs synchronously to completion inside FakeWebviewSource.ensure() (no
      // awaits in its body), so the tab already has a fresh webview by the time kill() returns.
      const recreatedRaw = h.webviews.raws.get("t1");
      expect(recreatedRaw).toBeDefined();
      expect(recreatedRaw).not.toBe(originalRaw);

      const adapter = createWebAdapter({
        webviews: h.webviews,
        runtime: "browser",
        runsDir: h.dir,
        packagesNodeModules: join(h.dir, "node_modules"),
        bunLockPath: join(h.dir, "bun.lock"),
        vendorCache: { get: async () => null, set: async () => {} },
        bundleVendor: async () => ({ code: "VENDOR", map: "VMAP", vendorCacheable: true, closure: [] }),
        runLock: { add: () => {}, remove: () => {} },
        directoryExists: async () => true,
        readBunLock: async () => LOCK_TEXT,
        bundle: async () => ({ code: "AFTER-KILL", map: "MAP", imports: ["react"], vendorCacheable: true }),
      });
      const run2: PreparedRun = {
        runId: "run-2",
        tabId: "t1",
        code: "4 + 4",
        maxEntries: 10_000,
        workingDirectory: null,
        mapEvent: identityMap,
        isCancelled: () => false,
      };
      await adapter.start(run2, {
        attached: () => {},
        events: () => {},
        state: () => {},
        heartbeat: () => {},
        exited: () => {},
      });

      expect(h.webviews.raws.get("t1")).toBe(recreatedRaw); // reused the recreated webview, not a third one
      expect(recreatedRaw?.reloadCount).toBe(1); // this run's own reset(), on the already-fresh webview
      expect(parseHostMessageCall(recreatedRaw?.executed.at(-1) as string)).toEqual({
        seq: 1,
        message: {
          type: "run",
          runId: "run-2",
          code: joinVendorAndApp("VENDOR", "AFTER-KILL"),
          settings: { maxEntries: 10_000 },
          muted: false,
        },
      });
    } finally {
      await rm(h.dir, { recursive: true, force: true });
    }
  });
});

/**
 * Task 8a: the vendor cache's read path. The cache key (the `bun.lock` hash plus the import set) describes the
 * vendor chunk and nothing else -- it cannot tell whether the tab's own code changed, and under Auto Run that code
 * changes constantly without the import set moving. So a hit may skip the vendor build and only the vendor build;
 * the app chunk is rebuilt every single run. These tests exist to keep it that way.
 */
describe("WebAdapter vendor cache read path (Task 8a)", () => {
  test("a cache hit reuses the stored vendor chunk and skips the vendor build, but still rebuilds the app chunk", async () => {
    let vendorBuilds = 0;
    let appBuilds = 0;
    const h = await createHarness({
      vendorCache: {
        get: async () => ({ code: "CACHED-VENDOR", map: "CACHED-MAP", closure: [] }),
        set: async () => {},
      },
      bundle: async () => {
        appBuilds++;
        return { code: `APP-${appBuilds}`, map: "MAP", imports: ["react"], vendorCacheable: true };
      },
      bundleVendor: async () => {
        vendorBuilds++;
        return { code: "FRESH-VENDOR", map: "VMAP", vendorCacheable: true, closure: [] };
      },
    });
    try {
      expect(appBuilds).toBe(1);
      expect(vendorBuilds).toBe(0);
      expect(parseHostMessageCall(h.raw.executed.at(-1) as string).message).toEqual({
        type: "run",
        runId: "run-1",
        code: joinVendorAndApp("CACHED-VENDOR", "APP-1"),
        settings: { maxEntries: 10_000 },
        muted: false,
      });
    } finally {
      await rm(h.dir, { recursive: true, force: true });
    }
  });

  // The regression this whole task is guarding against: edit the code, keep the imports, and the run must execute
  // the code as just edited. If the cache ever served a whole previous bundle (or the app chunk with it), the
  // second run below would still be running "APP-1".
  test("app code edited with the imports unchanged runs the NEW app code beside the cached vendor chunk", async () => {
    const stored = new Map<string, { code: string; map: string; closure: string[] | null }>();
    let vendorBuilds = 0;
    const vendorCache = {
      get: async (key: string) => stored.get(key) ?? null,
      set: async (key: string, chunk: { code: string; map: string }, closure?: readonly string[]) => {
        stored.set(key, { ...chunk, closure: closure ? [...closure] : null });
      },
    };
    const bundleVendor = async () => {
      vendorBuilds++;
      return { code: `VENDOR-${vendorBuilds}`, map: "VMAP", vendorCacheable: true, closure: ["react", "scheduler"] };
    };
    const h = await createHarness({
      vendorCache,
      bundleVendor,
      bundle: async () => ({ code: "APP-1", map: "MAP", imports: ["react"], vendorCacheable: true }),
    });
    try {
      expect(vendorBuilds).toBe(1); // first run: a miss, so the vendor chunk is built and stored
      expect(stored.size).toBe(1);
      // Fix round 2: the provenance the vendor build reported is persisted with the entry, because that is what a
      // later read -- possibly from another tab, with its own project tree -- has to re-check.
      expect([...stored.values()][0]?.closure).toEqual(["react", "scheduler"]);

      const adapter = createWebAdapter({
        webviews: h.webviews,
        runtime: "browser",
        runsDir: h.dir,
        packagesNodeModules: join(h.dir, "node_modules"),
        bunLockPath: join(h.dir, "bun.lock"),
        vendorCache,
        runLock: { add: () => {}, remove: () => {} },
        directoryExists: async () => true,
        readBunLock: async () => LOCK_TEXT,
        bundle: async () => ({ code: "APP-2", map: "MAP", imports: ["react"], vendorCacheable: true }),
        bundleVendor,
      });
      await adapter.start(
        {
          runId: "run-2",
          tabId: "t1",
          code: "edited code",
          maxEntries: 10_000,
          workingDirectory: null,
          mapEvent: identityMap,
          isCancelled: () => false,
        },
        { attached: () => {}, events: () => {}, state: () => {}, heartbeat: () => {}, exited: () => {} },
      );

      expect(vendorBuilds).toBe(1); // second run: a hit, so no second vendor build
      const second = parseHostMessageCall(h.raw.executed.at(-1) as string);
      expect(second.message).toEqual({
        type: "run",
        runId: "run-2",
        code: joinVendorAndApp("VENDOR-1", "APP-2"),
        settings: { maxEntries: 10_000 },
        muted: false,
      });
      // Belt and braces: the previous run's app code must appear nowhere in what the page was asked to run.
      expect((second.message as { code: string }).code).not.toContain("APP-1");
    } finally {
      await rm(h.dir, { recursive: true, force: true });
    }
  });

  // `bun.lock` describes the shared packages folder only. A package resolved out of the tab's own working
  // directory can change with no key change at all, so such a chunk is neither read nor written.
  test("a package resolved from the working directory is never read from, or written to, the cache", async () => {
    let gets = 0;
    let vendorBuilds = 0;
    const h = await createHarness({
      vendorCache: {
        get: async () => {
          gets++;
          return { code: "CACHED-VENDOR", map: "CACHED-MAP", closure: [] };
        },
        set: async () => {},
      },
      bundle: async () => ({ code: "APP", map: "MAP", imports: ["wd-pkg"], vendorCacheable: false }),
      bundleVendor: async () => {
        vendorBuilds++;
        return { code: "FRESH-VENDOR", map: "VMAP", vendorCacheable: true, closure: [] };
      },
    });
    try {
      expect(gets).toBe(0);
      expect(vendorBuilds).toBe(1);
      expect(h.vendorSets).toEqual([]);
      expect(parseHostMessageCall(h.raw.executed.at(-1) as string).message).toMatchObject({
        code: joinVendorAndApp("FRESH-VENDOR", "APP"),
      });
    } finally {
      await rm(h.dir, { recursive: true, force: true });
    }
  });

  // Fix round 1 (C1), adapter half. The app build's verdict covers direct imports only; the vendor build sees the
  // whole transitive closure. A chunk it reports as unkeyable must still RUN -- the user's code is fine -- but it
  // must never be stored, or a different tab with no working directory could hit the same key and execute this
  // tab's project code.
  test("a vendor chunk the vendor build reports as unkeyable runs but is never stored", async () => {
    const h = await createHarness({
      bundle: async () => ({ code: "APP", map: "MAP", imports: ["shared-pkg"], vendorCacheable: true }),
      bundleVendor: async () => ({
        code: "VENDOR-WITH-WD-CODE",
        map: "VMAP",
        vendorCacheable: false,
        closure: ["wd-pkg"],
      }),
    });
    try {
      expect(h.vendorSets).toEqual([]);
      expect(parseHostMessageCall(h.raw.executed.at(-1) as string).message).toMatchObject({
        code: joinVendorAndApp("VENDOR-WITH-WD-CODE", "APP"),
      });
    } finally {
      await rm(h.dir, { recursive: true, force: true });
    }
  });

  test("a failing vendor build is reported as a bundle error, like any other failure to produce the run's code", async () => {
    const h = await createHarness({
      bundleVendor: async () => ({ error: { message: "vendor build blew up" } }),
    });
    try {
      expect(h.states.at(-1)).toEqual({ state: "failed", activeHandles: undefined });
      expect(h.events.at(-1)).toMatchObject({ kind: "error", name: "BundleError", message: "vendor build blew up" });
      // Nothing was ever handed to the page to run.
      expect(h.raw.executed.some((js) => js.includes("__jslabHostMessage"))).toBe(false);
    } finally {
      await rm(h.dir, { recursive: true, force: true });
    }
  });

  // R-M4-T7-GAP-1: between the page reporting ready and the session wiring its listeners, the webview used to be
  // unobserved -- and bundling happens right in the middle of that window. A crash there reported nothing at all,
  // so the run hung with no handle for Stop or Kill to act on (both are no-ops while `run.handle` is null).
  test("GAP-1: a webview crash while the bundle is being built reports a terminal state instead of hanging", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jslab-web-adapter-"));
    try {
      const webviews = new FakeWebviewSource();
      const raw = new FakeRawWebview();
      webviews.raws.set("t1", raw);
      webviews.hosts.set("t1", createSequencedWebviewHost(raw, BOOTSTRAP_SOURCE));

      let bundleReached: () => void = () => {};
      const reachedBundle = new Promise<void>((resolve) => {
        bundleReached = resolve;
      });
      let releaseBundle: () => void = () => {};
      const bundleGate = new Promise<void>((resolve) => {
        releaseBundle = resolve;
      });

      const events: RunEvent[] = [];
      const states: { state: RunState; activeHandles?: number }[] = [];
      const adapter = createWebAdapter({
        webviews,
        runtime: "browser",
        runsDir: dir,
        packagesNodeModules: join(dir, "node_modules"),
        bunLockPath: join(dir, "bun.lock"),
        vendorCache: { get: async () => null, set: async () => {} },
        runLock: { add: () => {}, remove: () => {} },
        directoryExists: async () => true,
        readBunLock: async () => LOCK_TEXT,
        bundleVendor: async () => ({ code: "VENDOR", map: "VMAP", vendorCacheable: true, closure: [] }),
        bundle: async () => {
          bundleReached();
          await bundleGate;
          return { code: "APP", map: "MAP", imports: [], vendorCacheable: true };
        },
      });
      const startPromise = adapter.start(
        {
          runId: "run-1",
          tabId: "t1",
          code: "1 + 1",
          maxEntries: 10_000,
          workingDirectory: null,
          mapEvent: identityMap,
          isCancelled: () => false,
        },
        {
          attached: () => {},
          events: (batch) => events.push(...batch),
          state: (state, activeHandles) => states.push({ state, activeHandles }),
          heartbeat: () => {},
          exited: () => {},
        },
      );

      await reachedBundle;
      raw.crash(); // the page dies mid-bundle, with nothing wired to it yet
      releaseBundle();
      await startPromise; // must resolve, not hang

      expect(states.at(-1)).toEqual({ state: "failed", activeHandles: undefined });
      expect(events.at(-1)).toMatchObject({ kind: "error", phase: "runner" });
      // The dead page is never asked to run anything.
      expect(raw.executed.some((js) => js.includes("__jslabHostMessage"))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // Fix round 1 (M3). A crash landing while the working-directory check is in flight used to report a terminal
  // state twice: the crash listener's `failed`, and then the coordinator's own `#failWorkingDirectory` after
  // `start()` threw. The crash check now gates the throw, so the run reports once and `start()` returns a dead
  // handle rather than throwing at a coordinator that has already been told.
  test("M3: a crash during the working-directory check reports exactly one terminal state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jslab-web-adapter-"));
    try {
      const webviews = new FakeWebviewSource();
      const raw = new FakeRawWebview();
      webviews.raws.set("t1", raw);
      webviews.hosts.set("t1", createSequencedWebviewHost(raw, BOOTSTRAP_SOURCE));
      const states: { state: RunState; activeHandles?: number }[] = [];
      const adapter = createWebAdapter({
        webviews,
        runtime: "browser",
        runsDir: dir,
        packagesNodeModules: join(dir, "node_modules"),
        bunLockPath: join(dir, "bun.lock"),
        vendorCache: { get: async () => null, set: async () => {} },
        bundleVendor: async () => ({ code: "VENDOR", map: "VMAP", vendorCacheable: true, closure: [] }),
        runLock: { add: () => {}, remove: () => {} },
        // The page dies while we are asking the filesystem about the working directory, and the directory is gone.
        directoryExists: async () => {
          raw.crash();
          return false;
        },
        readBunLock: async () => LOCK_TEXT,
        bundle: async () => ({ code: "APP", map: "MAP", imports: [], vendorCacheable: true }),
      });

      const handle = await adapter.start(
        {
          runId: "run-1",
          tabId: "t1",
          code: "1 + 1",
          maxEntries: 10_000,
          workingDirectory: "/work",
          mapEvent: identityMap,
          isCancelled: () => false,
        },
        {
          attached: () => {},
          events: () => {},
          state: (state, activeHandles) => states.push({ state, activeHandles }),
          heartbeat: () => {},
          exited: () => {},
        },
      );

      expect(handle.runId).toBe("run-1");
      expect(states).toEqual([{ state: "failed", activeHandles: undefined }]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  /** Writes a real, resolvable package into a tab's own `node_modules`, so resolution is exercised for real. */
  async function writeProjectPackage(workingDirectory: string, name: string): Promise<void> {
    const packageDir = join(workingDirectory, "node_modules", name);
    await mkdir(packageDir, { recursive: true });
    await writeFile(join(packageDir, "package.json"), JSON.stringify({ name, main: "index.js" }));
    await writeFile(join(packageDir, "index.js"), "module.exports = 'from-the-users-project';");
  }

  /**
   * Fix round 2, and the shape of the test matters as much as the assertion. The cache key carries no
   * working-directory component -- a tab with one and a tab without produce the identical key -- so the chunk here
   * was stored by *another* tab and is offered to this one on its **very first run**, with the shadowing package
   * present the whole time. A sequential test (same tab, run twice) would pass with this hole wide open, because it
   * would only ever read back a chunk this tab itself had just stored.
   */
  test("a chunk another tab stored is refused on this tab's FIRST run when the tab's own project shadows one of its packages", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jslab-web-adapter-"));
    try {
      const workingDirectory = join(dir, "project");
      await writeProjectPackage(workingDirectory, "transitive-dep");

      const webviews = new FakeWebviewSource();
      let cacheReads = 0;
      let vendorBuilds = 0;
      const adapter = createWebAdapter({
        webviews,
        runtime: "browser",
        runsDir: dir,
        packagesNodeModules: join(dir, "pkgs", "node_modules"),
        bunLockPath: join(dir, "bun.lock"),
        vendorCache: {
          // Clean when it was stored: built entirely from the shared packages folder, by a tab with no project.
          get: async () => {
            cacheReads++;
            return { code: "OTHER-TABS-VENDOR", map: "M", closure: ["shared-pkg", "transitive-dep"] };
          },
          set: async () => {},
        },
        runLock: { add: () => {}, remove: () => {} },
        directoryExists: async () => true,
        readBunLock: async () => LOCK_TEXT,
        bundle: async () => ({ code: "APP", map: "MAP", imports: ["shared-pkg"], vendorCacheable: true }),
        bundleVendor: async () => {
          vendorBuilds++;
          return { code: "FRESH-VENDOR", map: "VMAP", vendorCacheable: false, closure: ["shared-pkg"] };
        },
      });

      await adapter.start(
        {
          runId: "run-1",
          tabId: "t1",
          code: "1 + 1",
          maxEntries: 10_000,
          workingDirectory,
          mapEvent: identityMap,
          isCancelled: () => false,
        },
        { attached: () => {}, events: () => {}, state: () => {}, heartbeat: () => {}, exited: () => {} },
      );

      expect(cacheReads).toBe(1); // the entry was found...
      expect(vendorBuilds).toBe(1); // ...and refused, because this tab's project shadows `transitive-dep`
      const raw = webviews.raws.get("t1");
      expect(parseHostMessageCall(raw?.executed.at(-1) as string).message).toMatchObject({
        code: joinVendorAndApp("FRESH-VENDOR", "APP"),
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // The control for the test above: without it, refusing *every* chunk would pass that test while quietly
  // disabling the cache. Same tab shape, same stored chunk -- only the project's contents differ.
  test("the same stored chunk IS served to a tab whose project shadows nothing in it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jslab-web-adapter-"));
    try {
      const workingDirectory = join(dir, "project");
      await writeProjectPackage(workingDirectory, "something-else-entirely");

      const webviews = new FakeWebviewSource();
      let vendorBuilds = 0;
      const adapter = createWebAdapter({
        webviews,
        runtime: "browser",
        runsDir: dir,
        packagesNodeModules: join(dir, "pkgs", "node_modules"),
        bunLockPath: join(dir, "bun.lock"),
        vendorCache: {
          get: async () => ({ code: "OTHER-TABS-VENDOR", map: "M", closure: ["shared-pkg", "transitive-dep"] }),
          set: async () => {},
        },
        runLock: { add: () => {}, remove: () => {} },
        directoryExists: async () => true,
        readBunLock: async () => LOCK_TEXT,
        bundle: async () => ({ code: "APP", map: "MAP", imports: ["shared-pkg"], vendorCacheable: true }),
        bundleVendor: async () => {
          vendorBuilds++;
          return { code: "FRESH-VENDOR", map: "VMAP", vendorCacheable: true, closure: ["shared-pkg"] };
        },
      });

      await adapter.start(
        {
          runId: "run-1",
          tabId: "t1",
          code: "1 + 1",
          maxEntries: 10_000,
          workingDirectory,
          mapEvent: identityMap,
          isCancelled: () => false,
        },
        { attached: () => {}, events: () => {}, state: () => {}, heartbeat: () => {}, exited: () => {} },
      );

      expect(vendorBuilds).toBe(0); // the cached chunk was good for this tab, so nothing was rebuilt
      const raw = webviews.raws.get("t1");
      expect(parseHostMessageCall(raw?.executed.at(-1) as string).message).toMatchObject({
        code: joinVendorAndApp("OTHER-TABS-VENDOR", "APP"),
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // An entry whose provenance was never recorded (today only one an index rebuild reconstructed from filenames,
  // since a filename cannot carry it) is unusable for a tab that has a project of its own: unknown provenance must
  // read as "refuse", never as "nothing to check".
  test("a cached chunk with no recorded provenance is refused for a tab that has a working directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jslab-web-adapter-"));
    try {
      const workingDirectory = join(dir, "project");
      await writeProjectPackage(workingDirectory, "something-else-entirely");

      const webviews = new FakeWebviewSource();
      let vendorBuilds = 0;
      const adapter = createWebAdapter({
        webviews,
        runtime: "browser",
        runsDir: dir,
        packagesNodeModules: join(dir, "pkgs", "node_modules"),
        bunLockPath: join(dir, "bun.lock"),
        vendorCache: {
          get: async () => ({ code: "PROVENANCE-UNKNOWN-VENDOR", map: "M", closure: null }),
          set: async () => {},
        },
        runLock: { add: () => {}, remove: () => {} },
        directoryExists: async () => true,
        readBunLock: async () => LOCK_TEXT,
        bundle: async () => ({ code: "APP", map: "MAP", imports: ["shared-pkg"], vendorCacheable: true }),
        bundleVendor: async () => {
          vendorBuilds++;
          return { code: "FRESH-VENDOR", map: "VMAP", vendorCacheable: true, closure: ["shared-pkg"] };
        },
      });

      await adapter.start(
        {
          runId: "run-1",
          tabId: "t1",
          code: "1 + 1",
          maxEntries: 10_000,
          workingDirectory,
          mapEvent: identityMap,
          isCancelled: () => false,
        },
        { attached: () => {}, events: () => {}, state: () => {}, heartbeat: () => {}, exited: () => {} },
      );

      expect(vendorBuilds).toBe(1);
      const raw = webviews.raws.get("t1");
      expect(parseHostMessageCall(raw?.executed.at(-1) as string).message).toMatchObject({
        code: joinVendorAndApp("FRESH-VENDOR", "APP"),
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
