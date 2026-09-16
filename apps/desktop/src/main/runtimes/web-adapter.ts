import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { EncodedValue, HostToWebMessage, RunEvent, WebToHostMessage } from "@jslab/rpc-schema";
import type { Runtime } from "@jslab/shared";
import { type BundleOptions, bundleForWeb } from "../bundling/bundler";
import { hashBunLock, type VendorCache, vendorCacheKey } from "../bundling/vendor-cache";
import {
  type PreparedRun,
  type RunEventSink,
  type RunHandle,
  type RuntimeAdapter,
  type TabRunContext,
  WorkingDirectoryMismatchError,
} from "./adapter";

/**
 * The minimal, Electrobun-webview-shaped primitive `createSequencedWebviewHost` drives. Deliberately close to the
 * real `<electrobun-webview>` tag's own surface (`executeJavascript`, `reload`, `dom-ready`/`did-navigate`,
 * `host-message`, `destroy`) -- per Electrobun 2.0.1's public API (`.hutch/releases/electrobun/2.0.1/.../
 * webviewtag.ts`) -- so a real implementation is a thin wrapper over the actual DOM element / `BrowserView` Task 8
 * renders for a tab's Web View tile, not a parallel protocol invented here. Building that concrete, Electrobun-
 * backed implementation is out of this task's scope: it requires a live `<electrobun-webview>` DOM node, which only
 * exists once Task 8's tile mounts one -- see the task report for the full reasoning.
 */
export interface RawWebview {
  /** Injects and runs `js` inside the page (Electrobun's own `executeJavascript`). */
  executeJavascript(js: string): void;
  /** Reloads the page. The caller is notified once it's safe to inject script via `onLoaded`. */
  reload(): void;
  /**
   * Fires once after every `reload()` (and once for the tab's very first load), at the point Electrobun's own
   * `dom-ready`/`did-navigate` webview event fires -- which is also the point Electrobun's platform-injected
   * `window.__electrobunSendToHost` hook is already guaranteed present (it is injected "before application scripts
   * run", confirmed by the M0 spike -- `.superpowers/sdd/.../prep-m4-asbuilt.md` §6). Injecting the runner-web
   * bootstrap only after this fires (decision 2, below) is what guarantees the hook exists before the bootstrap's
   * first `bridge.send({type:'ready'})` call ever executes.
   */
  onLoaded(listener: () => void): () => void;
  /** Fires when the page relays a `host-message` (the runner-web bridge's outbound `WebToHost` envelope). */
  onHostMessage(listener: (raw: unknown) => void): () => void;
  /** Fires if the webview dies unexpectedly (a crash, an external teardown) -- never for this host's own `destroy()`. */
  onCrashed(listener: () => void): () => void;
  /** Tears the underlying webview down for good. */
  destroy(): void;
}

/** The seam `WebAdapter` drives: one per browser-mode tab, unit-tested here against a fake (see the test file). */
export interface WebviewHost {
  /**
   * Reloads the page for a fresh realm/DOM (spec §5.12 step 1-2, "Main sends `runner.reset`... the page reloads"),
   * then re-injects the bootstrap once the page reports it's ready to receive script. Resolves once injection has
   * happened -- NOT once the bootstrap's own `ready` message arrives; the caller awaits that separately via
   * `onMessage` (see `WebAdapter.start()`), since "the bootstrap ran" and "the bootstrap's first round-trip
   * completed" are two different events.
   */
  reset(): Promise<void>;
  /** Delivers one host->page message, wrapped with the next strictly-consecutive sequence number (decision 3). */
  send(message: HostToWebMessage): void;
  /** Subscribes to inbound page->host messages. Returns an unsubscribe function. */
  onMessage(listener: (message: WebToHostMessage) => void): () => void;
  /** Fires if the webview died unexpectedly (never for this host's own `destroy()`). */
  onExit(listener: () => void): () => void;
  /** Tears this webview down for good (used by Kill and by tab dispose/invalidate). */
  destroy(): void;
}

/** Gets (creating if needed) or destroys the one persistent `<electrobun-webview>` a browser-mode tab owns. */
export interface WebviewSource {
  ensure(tab: TabRunContext): Promise<WebviewHost>;
  destroy(tabId: string): void;
}

/** A minimal shape check on the raw `host-message` payload; `message`'s inner discriminant is trusted from there. */
function isWebToHostEnvelope(value: unknown): value is { seq: number; message: WebToHostMessage } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { seq?: unknown }).seq === "number" &&
    typeof (value as { message?: unknown }).message === "object" &&
    (value as { message?: unknown }).message !== null &&
    typeof (value as { message: { type?: unknown } }).message.type === "string"
  );
}

/**
 * Decision 2 (bridge ordering): prepended to whatever is injected as the runner-web bootstrap. It's a defensive
 * assertion, not the actual guarantee -- the guarantee is structural (see `RawWebview.onLoaded`'s doc comment): the
 * bootstrap is only ever injected after Electrobun's own `dom-ready`/`did-navigate`, by which point the platform
 * has already installed `__electrobunSendToHost`. If that platform ordering ever regresses (a future Electrobun
 * version, a packaging change), this throws loudly inside the page instead of silently dropping the first `ready`
 * message, which would otherwise look exactly like a hung runner.
 */
export const ASSERT_HOST_HOOK_SNIPPET =
  'if (typeof window.__electrobunSendToHost !== "function") { throw new Error("JSLab: __electrobunSendToHost missing before runner-web bootstrap injection"); }';

/**
 * Wraps a `RawWebview` primitive with the bridge discipline decisions 2 and 3 pin to this task:
 * - Decision 2: the bootstrap is injected only once `onLoaded` fires (never earlier), with `ASSERT_HOST_HOOK_SNIPPET`
 *   prepended so a broken guarantee fails loudly.
 * - Decision 3: outbound `seq` is a strictly consecutive counter starting at 1, reset to 0 (so the next send is 1)
 *   every time `reset()` reloads the page -- matching `host-bridge.ts`'s page-side requirement that an inbound
 *   message's `seq` be exactly `lastInboundSeq + 1`, per connection.
 */
export function createSequencedWebviewHost(raw: RawWebview, bootstrapSource: string): WebviewHost {
  let seq = 0;
  const messageListeners = new Set<(message: WebToHostMessage) => void>();
  raw.onHostMessage((incoming) => {
    if (!isWebToHostEnvelope(incoming)) return;
    for (const listener of [...messageListeners]) listener(incoming.message);
  });

  return {
    reset(): Promise<void> {
      seq = 0;
      return new Promise((resolve) => {
        const unsub = raw.onLoaded(() => {
          unsub();
          raw.executeJavascript(`${ASSERT_HOST_HOOK_SNIPPET}\n${bootstrapSource}`);
          resolve();
        });
        raw.reload();
      });
    },
    send(message: HostToWebMessage): void {
      seq += 1;
      raw.executeJavascript(`window.__jslabHostMessage(${JSON.stringify({ seq, message })});`);
    },
    onMessage(listener: (message: WebToHostMessage) => void): () => void {
      messageListeners.add(listener);
      return () => messageListeners.delete(listener);
    },
    onExit(listener: () => void): () => void {
      return raw.onCrashed(listener);
    },
    destroy(): void {
      raw.destroy();
    },
  };
}

export interface WebAdapterDeps {
  webviews: WebviewSource;
  runtime: Extract<Runtime, "browser" | "browser-node">;
  /** Where per-run entry files are written before bundling (mirrors `BunAdapterDeps.runsDir`). */
  runsDir: string;
  packagesNodeModules: string;
  /** `<appdata>/packages/bun.lock` -- read once per run to key the vendor cache (Task 6). */
  bunLockPath: string;
  /**
   * Only `set()` is used (write-only): see the task report for why a cache hit is never trusted to skip a build.
   * `bundleForWeb`'s single-entrypoint, unsplit output has no way to separate reusable third-party code from this
   * run's own (constantly-changing, under Auto Run) application code, so keying a full-bundle cache on
   * `bun.lock` hash + import set alone -- with no way to also verify the app code is unchanged -- cannot safely
   * stand in for a fresh build without risking stale output for a correctness-critical surface.
   */
  vendorCache: Pick<VendorCache, "set">;
  runLock: { add(runId: string): void; remove(runId: string): void };
  /** Stop's graceful-then-kill escalation window (spec §5.8). Defaults to 500 ms. */
  stopGraceMs?: number;
  /** How long `expand()` waits for a reply before resolving null. Defaults to 5 s. */
  expandTimeoutMs?: number;
  /** Test seam; production always calls the real `bundleForWeb`. */
  bundle?(options: BundleOptions): ReturnType<typeof bundleForWeb>;
  /** Test seam for the working-directory fail-closed check. */
  directoryExists?(path: string): Promise<boolean>;
  /** Test seam for reading `bunLockPath`. */
  readBunLock?(path: string): Promise<string>;
}

function deadHandle(runId: string): RunHandle {
  return { runId, stop: () => Promise.resolve(), kill: () => {}, expand: () => Promise.resolve(null) };
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function bundleErrorEvent(message: string, line?: number, column?: number, codeFrame?: string): RunEvent {
  return {
    kind: "error",
    phase: "transpile",
    name: "BundleError",
    message,
    ...(line !== undefined ? { line } : {}),
    ...(column !== undefined ? { column } : {}),
    ...(codeFrame ? { codeFrame } : {}),
    stack: [],
    seq: 1,
    t: Date.now(),
  };
}

/**
 * One Web run in flight: owns the webview host's message conversation. Mirrors `BunRunSession` (`bun-adapter.ts`)
 * as closely as the two transports allow; the doc comments below call out the places they genuinely diverge.
 */
class WebRunSession implements RunHandle {
  readonly runId: string;
  #stopRequested = false;
  #terminal: "stopped" | "killed" | null = null;
  /** `sink.exited()` is called exactly once -- see `#retireHandle`. */
  #retired = false;
  #stopTimer?: ReturnType<typeof setTimeout>;
  #stopSettle?: () => void;
  #unsubMessage: () => void = () => {};
  #unsubExit: () => void = () => {};
  #nextReqId = 1;
  readonly #pendingExpands = new Map<number, (value: EncodedValue | null) => void>();

  constructor(
    private readonly host: WebviewHost,
    private readonly run: PreparedRun,
    private readonly sink: RunEventSink,
    private readonly deps: WebAdapterDeps,
  ) {
    this.runId = run.runId;
  }

  wire(): void {
    this.#unsubMessage = this.host.onMessage((message) => this.#onMessage(message));
    this.#unsubExit = this.host.onExit(() => this.#onCrash());
  }

  get stopRequested(): boolean {
    return this.#stopRequested;
  }

  async stop(): Promise<void> {
    if (this.#terminal) return;
    this.#stopRequested = true;
    this.host.send({ type: "stop" });
    return new Promise((resolve) => {
      this.#stopSettle = resolve;
      this.#stopTimer = setTimeout(() => {
        if (this.#terminal) {
          resolve();
          return;
        }
        this.#terminal = "killed";
        this.#killWebview();
        resolve();
      }, this.deps.stopGraceMs ?? 500);
    });
  }

  kill(): void {
    clearTimeout(this.#stopTimer);
    if (this.#terminal) return;
    this.#terminal = "killed";
    this.#killWebview();
  }

  expand(handleId: string): Promise<EncodedValue | null> {
    const reqId = this.#nextReqId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#pendingExpands.delete(reqId);
        resolve(null);
      }, this.deps.expandTimeoutMs ?? 5000);
      this.#pendingExpands.set(reqId, (value) => {
        clearTimeout(timer);
        resolve(value);
      });
      this.host.send({ type: "expand", reqId, handleId });
    });
  }

  /**
   * Kill's teardown (spec §5.8: "destroys and recreates the webview"). Escalated Stop lands here too -- unlike
   * `BunRunSession`, a graceful "stopped" completion (`#onMessage`'s "state" case, below) does NOT call this: a
   * webview's realm is reset cheaply by `host.reset()`'s reload on the tab's *next* run (decision 1), so there is
   * no need to pay for a full destroy+recreate on every ordinary completion the way Bun must pay for a fresh
   * process. Destroy+recreate is reserved for Kill, matching the spec calling it out as Kill's own distinct
   * behaviour rather than something every run already does.
   */
  #killWebview(): void {
    this.deps.webviews.destroy(this.run.tabId);
    void this.deps.webviews
      .ensure({ tabId: this.run.tabId, workingDirectory: this.run.workingDirectory })
      .catch(() => {});
    this.#retireHandle();
  }

  /**
   * Retires this run's *handle* (idempotent). Deliberately decoupled from "the webview is gone" (`RunEventSink.
   * exited()`'s doc comment says "gone for good", but for Web the webview outlives an ordinary completion) --
   * here it means "this run's handle is done", so `RunCoordinator` stops tracking it (`run.handle = null`) and a
   * later stray Stop/Kill/expand for this same run is a safe no-op, exactly as it is for Bun.
   */
  #retireHandle(): void {
    if (this.#retired) return;
    this.#retired = true;
    clearTimeout(this.#stopTimer);
    for (const settle of [...this.#pendingExpands.values()]) settle(null);
    this.#pendingExpands.clear();
    this.#unsubMessage();
    this.#unsubExit();
    this.deps.runLock.remove(this.run.runId);
    this.sink.exited();
  }

  #onMessage(message: WebToHostMessage): void {
    switch (message.type) {
      case "ready":
        // Consumed by `start()`'s own one-shot listener before this session exists; a stray repeat is ignored.
        return;
      case "heartbeat":
        this.sink.heartbeat();
        return;
      case "events":
        if (this.#terminal) return;
        this.sink.events(message.events.map((event) => this.run.mapEvent(event)));
        return;
      case "state": {
        if (message.state === "stopped") {
          clearTimeout(this.#stopTimer);
          this.#stopSettle?.();
        }
        if (message.state !== "evaluating") this.deps.runLock.remove(this.run.runId);
        if (this.#stopRequested && message.state !== "stopped") return;
        this.sink.state(message.state, message.activeHandles);
        if (message.state === "stopped") {
          this.#terminal = "stopped";
          this.#retireHandle();
        }
        return;
      }
      case "expanded":
        this.#pendingExpands.get(message.reqId)?.(message.value);
        this.#pendingExpands.delete(message.reqId);
        return;
    }
  }

  #onCrash(): void {
    if (this.#terminal) {
      this.#retireHandle();
      return;
    }
    this.#terminal = "killed";
    this.#retireHandle();
    this.sink.events([
      {
        kind: "error",
        phase: "runner",
        name: "RuntimeError",
        message: "Web runner exited unexpectedly.",
        stack: [],
        seq: Number.MAX_SAFE_INTEGER,
        t: Date.now(),
      },
    ]);
    this.sink.state("failed");
  }
}

/**
 * The Web `RuntimeAdapter` (spec §5.1, §5.12): one instance per web runtime id (`browser`, `browser-node`), both
 * sharing the same `WebviewSource` -- a tab's chosen runtime is fixed at tab-creation, so there is never a conflict
 * over which of the two owns a given tab's webview.
 */
export function createWebAdapter(deps: WebAdapterDeps): RuntimeAdapter {
  return {
    id: deps.runtime,

    async prepare(tab: TabRunContext): Promise<void> {
      await deps.webviews.ensure(tab).catch(() => {});
    },

    invalidate(tab: TabRunContext): void {
      deps.webviews.destroy(tab.tabId);
    },

    async dispose(tabId: string): Promise<void> {
      deps.webviews.destroy(tabId);
    },

    async start(run: PreparedRun, sink: RunEventSink): Promise<RunHandle> {
      // Fail closed on the working directory (adapted from `RunCoordinator.#execute`'s `runner.cwd` comparison): a
      // webview has no OS cwd to compare a live property against, so this re-verifies the scope Main is about to
      // hand the bundler directly against the filesystem, right before using it -- closing the same TOCTOU window
      // (the directory vanishing between an earlier check and actual use) Bun's own check closes differently.
      if (run.workingDirectory && !(await (deps.directoryExists ?? directoryExists)(run.workingDirectory))) {
        throw new WorkingDirectoryMismatchError(run.workingDirectory);
      }
      if (run.isCancelled()) return deadHandle(run.runId);

      const host = await deps.webviews.ensure({ tabId: run.tabId, workingDirectory: run.workingDirectory });
      if (run.isCancelled()) return deadHandle(run.runId);

      // Spec §5.12 steps 1-2 ("Main sends runner.reset... the page reloads"), decision 1: every run gets a fresh
      // realm/DOM via reload, not just Stop/Kill -- see the report for why this is safe without an uninstall path.
      const ready = new Promise<void>((resolve) => {
        const unsubscribe = host.onMessage((message) => {
          if (message.type === "ready") {
            unsubscribe();
            resolve();
          }
        });
      });
      await host.reset();
      await ready;
      if (run.isCancelled()) return deadHandle(run.runId);

      const dir = join(deps.runsDir, run.tabId);
      await mkdir(dir, { recursive: true });
      if (run.isCancelled()) return deadHandle(run.runId);
      const entryPath = join(dir, `entry-${run.runId}.mjs`);
      await Bun.write(entryPath, run.code);
      if (run.isCancelled()) return deadHandle(run.runId);

      const bundle = deps.bundle ?? bundleForWeb;
      const result = await bundle({
        entry: entryPath,
        runtime: deps.runtime,
        workingDirectory: run.workingDirectory,
        packagesNodeModules: deps.packagesNodeModules,
      });
      if (run.isCancelled()) return deadHandle(run.runId);

      if ("error" in result) {
        sink.events([
          bundleErrorEvent(result.error.message, result.error.line, result.error.column, result.error.codeFrame),
        ]);
        sink.state("failed");
        return deadHandle(run.runId);
      }

      // Vendor cache (Task 6): write-only population under the spec's key (bun.lock hash + resolved import set) --
      // see `WebAdapterDeps.vendorCache`'s doc comment for why this never reads back to skip a build.
      try {
        const lockText = await (deps.readBunLock ?? readBunLockFile)(deps.bunLockPath);
        const key = vendorCacheKey(hashBunLock(lockText), result.imports);
        void deps.vendorCache.set(key, { code: result.code, map: result.map }).catch(() => {});
      } catch {
        // No bun.lock yet (no packages installed for this profile) -- nothing to key on; behave like a cache miss.
      }

      const session = new WebRunSession(host, run, sink, deps);
      session.wire();
      // Hand the handle back the moment it's controllable, before any lock or "run" message work (mirrors
      // `BunAdapter.start()`, M4 T2 fix 1): a stop()/kill() arriving reentrantly from `runLock.add` below must
      // find a handle to act on and take the graceful/already-terminal branch, not a bare cancel.
      sink.attached(session);
      deps.runLock.add(run.runId);
      if (session.stopRequested) return session;
      if (run.isCancelled()) {
        deps.runLock.remove(run.runId);
        return session;
      }
      host.send({ type: "run", runId: run.runId, code: result.code, settings: { maxEntries: run.maxEntries } });
      return session;
    },
  };
}

async function readBunLockFile(path: string): Promise<string> {
  return Bun.file(path).text();
}
