import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
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

  test("M1: start() prunes stale entry files from previous runs, keeping only the latest", async () => {
    const h = await createHarness();
    try {
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
        vendorCache: { set: async () => {} },
        runLock: { add: () => {}, remove: () => {} },
        directoryExists: async () => false,
        bundle: async () => {
          bundleCalls++;
          return { code: "x", map: "", imports: [] };
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
        vendorCache: { set: async () => {} },
        runLock: { add: () => {}, remove: () => {} },
        directoryExists: async () => !dirGone,
        bundle: async () => {
          bundleCalls++;
          return { code: "x", map: "", imports: [] };
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
        vendorCache: { set: async () => {} },
        runLock: { add: () => {}, remove: () => {} },
        expandTimeoutMs: 30,
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
        vendorCache: { set: async () => {} },
        runLock: { add: () => {}, remove: () => {} },
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
        vendorCache: { set: async () => {} },
        runLock: { add: () => {}, remove: () => {} },
        directoryExists: async () => true,
        readBunLock: async () => LOCK_TEXT,
        bundle: async () => ({ code: "AFTER-STOP", map: "MAP", imports: ["react"] }),
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
        message: { type: "run", runId: "run-2", code: "AFTER-STOP", settings: { maxEntries: 10_000 } },
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
        vendorCache: { set: async () => {} },
        runLock: { add: () => {}, remove: () => {} },
        directoryExists: async () => true,
        readBunLock: async () => LOCK_TEXT,
        bundle: async () => ({ code: "AFTER-KILL", map: "MAP", imports: ["react"] }),
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
        message: { type: "run", runId: "run-2", code: "AFTER-KILL", settings: { maxEntries: 10_000 } },
      });
    } finally {
      await rm(h.dir, { recursive: true, force: true });
    }
  });
});
