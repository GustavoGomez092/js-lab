import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EncodedValue, HostToWebMessage, RunEvent, RunState, WebToHostMessage } from "@jslab/rpc-schema";
import type { BundleOptions, BundleResult } from "../../src/main/bundling/bundler";
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
    if (this.autoReady && js.includes(ASSERT_HOST_HOOK_SNIPPET)) this.emit(1, { type: "ready" });
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
    (async (_options: BundleOptions): Promise<BundleResult> => ({ code: "BUNDLED", map: "MAP", imports: ["react"] }));
  const adapter = createWebAdapter({
    webviews,
    runtime: "browser",
    runsDir: dir,
    packagesNodeModules: join(dir, "node_modules"),
    bunLockPath: join(dir, "bun.lock"),
    vendorCache: {
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
  });
  const events: RunEvent[] = [];
  const states: Harness["states"] = [];
  let exitedCalls = 0;
  const sink: RunEventSink = {
    attached: () => {},
    events: (batch) => events.push(...batch),
    state: (state, activeHandles) => states.push({ state, activeHandles }),
    heartbeat: () => {},
    exited: () => {
      exitedCalls++;
    },
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
  return { webviews, raw, handle, events, states, exitedCalls: () => exitedCalls, locks, vendorSets, dir };
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
        message: { type: "run", runId: "run-1", code: "BUNDLED", settings: { maxEntries: 10_000 } },
      });

      expect(await readFile(join(h.dir, "t1", "entry-run-1.mjs"), "utf8")).toBe("1 + 1");
      expect(h.locks.has("run-1")).toBe(true);

      const expectedKey = vendorCacheKey(hashBunLock(LOCK_TEXT), ["react"]);
      expect(h.vendorSets).toEqual([{ key: expectedKey, chunk: { code: "BUNDLED", map: "MAP" } }]);
    } finally {
      await rm(h.dir, { recursive: true, force: true });
    }
  });

  test("start() fails closed when the working directory no longer exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jslab-web-adapter-"));
    try {
      const webviews = new FakeWebviewSource();
      const adapter = createWebAdapter({
        webviews,
        runtime: "browser",
        runsDir: dir,
        packagesNodeModules: join(dir, "node_modules"),
        bunLockPath: join(dir, "bun.lock"),
        vendorCache: { set: async () => {} },
        runLock: { add: () => {}, remove: () => {} },
        directoryExists: async () => false,
        bundle: async () => ({ code: "x", map: "", imports: [] }),
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
      expect(webviews.ensuredTabIds).toEqual([]);
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
        vendorCache: { set: async () => {} },
        runLock: { add: () => {}, remove: () => {} },
        directoryExists: async () => true,
        readBunLock: async () => LOCK_TEXT,
        bundle: async () => ({ code: "BUNDLED-2", map: "MAP", imports: ["react"] }),
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
        message: { type: "run", runId: "run-2", code: "BUNDLED-2", settings: { maxEntries: 10_000 } },
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
        vendorCache: { set: async () => {} },
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
});
