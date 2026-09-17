import { mkdir, readdir, stat, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import type { EncodedValue, HostToWebMessage, RunEvent, WebToHostMessage } from "@jslab/rpc-schema";
import type { Runtime } from "@jslab/shared";
import {
  type AppBundleResult,
  type BundleOptions,
  bundleAppForWeb,
  bundleVendorForWeb,
  joinVendorAndApp,
  type VendorBundleOptions,
  type VendorBundleResult,
} from "../bundling/bundler";
import { resolveBareSpecifier, resolvedFromWorkingDirectory } from "../bundling/resolve-plugin";
import { type CachedVendorChunk, hashBunLock, type VendorCache, vendorCacheKey } from "../bundling/vendor-cache";
import type { Redactor } from "../logging/redact";
import type { Log } from "../rpc/validate";
import { createWebFetchRunner, type WebFetchRunner } from "../rpc/web-fetch-handlers";
import { createWebNodeRunner, type WebNodeRunner } from "../rpc/web-node-handlers";
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
   *
   * `runtime` is which of the two web runtimes this tab is, and it is **required** rather than defaulted (Task 9b):
   * the page cannot discover it any other way. One `WebviewSource` is shared by both adapters and the bootstrap
   * bundle is byte-identical for every tab, so the injected prelude is the only channel -- and it has to be this
   * one, because `installFetchProxy` must run synchronously inside `startRunnerWeb` (before `installHandleTracking`
   * wraps `fetch`), which rules out learning the runtime from a later message. Defaulting it would silently give a
   * `browser-node` tab a CORS-enforced `fetch`, which is exactly the gap this parameter closes.
   */
  reset(runtime: WebRuntimeId): Promise<void>;
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

/** The two web runtimes, as `WebAdapter` is instantiated for each (`main-services.ts` registers one adapter each). */
export type WebRuntimeId = Extract<Runtime, "browser" | "browser-node">;

/**
 * Task 9b (ledger ruling R-M4-T13-FETCHWIRE-1): tells the page which web runtime it is, injected immediately before
 * the bootstrap in the same `executeJavascript` call. `packages/runner-web/src/web-entry.ts` reads it and passes it
 * to `startRunnerWeb`, which is what decides whether `installFetchProxy` routes `fetch` through Main at all. Before
 * this existed the entry called `startRunnerWeb()` with no arguments, so the runtime defaulted to `"browser"` and a
 * `browser-node` tab never got its proxy.
 *
 * A literal assignment rather than anything the page could have influenced: it is built here, from the adapter's own
 * fixed `deps.runtime`, and `JSON.stringify` on a value of a two-member string union cannot produce anything else.
 */
export function runtimePrelude(runtime: WebRuntimeId): string {
  return `window.__jslabRuntime = ${JSON.stringify(runtime)};`;
}

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
    reset(runtime: WebRuntimeId): Promise<void> {
      seq = 0;
      return new Promise((resolve) => {
        const unsub = raw.onLoaded(() => {
          unsub();
          raw.executeJavascript(`${ASSERT_HOST_HOOK_SNIPPET}\n${runtimePrelude(runtime)}\n${bootstrapSource}`);
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
   * Read and written, since Task 8a split the build in two (it was write-only before: a single unsplit output has
   * no way to separate reusable third-party code from this run's own). What a hit may skip is now exactly what the
   * key describes -- the vendor chunk. The app chunk is rebuilt on every run without exception, because the key
   * (the `bun.lock` hash plus the import set) cannot tell whether the tab's own code changed, and under Auto Run
   * it changes constantly while the import set stands still.
   */
  vendorCache: Pick<VendorCache, "get" | "set">;
  runLock: { add(runId: string): void; remove(runId: string): void };
  /** Stop's graceful-then-kill escalation window (spec §5.8). Defaults to 500 ms. */
  stopGraceMs?: number;
  /** How long `expand()` waits for a reply before resolving null. Defaults to 5 s. */
  expandTimeoutMs?: number;
  /** How long `waitForReady` waits for the page's ready round trip before tearing the webview down and failing the
   * run. Defaults to `WEBVIEW_READY_TIMEOUT_MS` (2 s) -- deliberately not `expandTimeoutMs` (see that constant). */
  webviewReadyTimeoutMs?: number;
  /** Test seam; production always calls the real `bundleAppForWeb`. */
  bundle?(options: BundleOptions): Promise<AppBundleResult>;
  /** Test seam; production always calls the real `bundleVendorForWeb`. */
  bundleVendor?(options: VendorBundleOptions): Promise<VendorBundleResult>;
  /** Test seam for the working-directory fail-closed check. */
  directoryExists?(path: string): Promise<boolean>;
  /** Test seam for reading `bunLockPath`. */
  readBunLock?(path: string): Promise<string>;
  /**
   * Fix round 1 (security): `WebRunSession` builds one `WebFetchRunner` (`../rpc/web-fetch-handlers.ts`) per
   * session from these, only when `runtime` is `"browser-node"` -- see `#onMessage`'s `"fetchRequest"` case for
   * why that check happens here rather than by looking a caller-supplied tab id up. Optional (a redact/log no-op
   * default applies) so every existing fixture across this file's own large test suite -- almost none of which
   * exercise `browser-node` fetch at all -- stays valid unchanged.
   */
  redact?: Redactor;
  log?: Log;
  /**
   * Task 11: the app's data directory -- what a `browser-node` tab's Node bridge resolves a relative path against
   * when the tab has no working directory, matching `../runs/runner-config.ts`'s
   * `const cwd = workingDirectory ?? deps.paths.dataDir` exactly, so the same relative path reaches the same file
   * under both runtimes.
   *
   * Optional for the same reason `redact`/`log` above are: this file's large existing fixture set predates it and
   * almost none of it exercises the Node bridge at all. `main-services.ts` always passes it in production.
   */
  dataDir?: string;
  /**
   * Task 9f item 6: the layered environment a bridged `child_process` command gets when the page supplies none.
   *
   * `main-services.ts` builds this through `../runs/runner-config.ts`'s `runnerContextFor` -- the same function the
   * Bun runner's own `configFor` uses -- so env.json, the working directory's `.env` and the `JSLAB_*`/`BUN_OPTIONS`
   * stripping all apply identically under both runtimes. Without it the bridge fell back to Main's raw
   * `process.env`, so a user's `.env` silently never applied to a `browser-node` tab.
   *
   * Optional like `dataDir` above, for the same reason: this file's existing fixture set predates it.
   */
  nodeEnvironment?(workingDirectory: string | null): Record<string, string>;
  /** Test seam; production always uses the runtime's own `fetch`. */
  webFetch?(url: string, init?: RequestInit): Promise<Response>;
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

/** Mirrors `bun-adapter.ts`'s `cleanupEntries` exactly: deletes every stale `entry-*.mjs` in `dir` but `keep`. */
async function cleanupEntries(dir: string, keep: string): Promise<void> {
  try {
    for (const name of await readdir(dir)) {
      if (name !== keep && name.startsWith("entry-")) await unlink(join(dir, name)).catch(() => {});
    }
  } catch {}
}

/**
 * `waitForReady`'s own bound (M4 T9c, closes ledger ruling R-M4-T7-TIMEOUT-1). Previously it reused
 * `expandTimeoutMs` (default 5 s) on the theory that both represent "how long do we wait for the page to respond
 * to something" -- but they are the wrong kind of bound to share. `expand()` timing out just resolves `null`
 * (`WebRunSession.expand`, harmless); this one tears the webview down (`webviews.destroy`) and fails the whole
 * run. Sharing a tunable also meant the two would silently drift apart the instant anyone tuned `expand` for its
 * own reason. Task 9a measured real `views://` ready time at 11-23 ms -- a 220-450x margin even against the old 5 s
 * bound, so tightening costs nothing; 2 s keeps two full orders of magnitude of headroom while finally being a
 * bound this call site owns outright.
 */
export const WEBVIEW_READY_TIMEOUT_MS = 2000;

/**
 * Waits for the page's `ready` message after `host.reset()`'s reload, bounded so a page that never loads (the
 * bootstrap's own `ASSERT_HOST_HOOK_SNIPPET` throwing before it can send `ready`, or a real webview crash/load
 * failure) cannot hang `start()` forever (fix round 1, C2). Unbounded, this left the run permanently unkillable:
 * `RunCoordinator.kill()`/`stop()` are both no-ops while `run.handle` is `null` (never set, since `sink.attached()`
 * is only called once `start()` returns), and the watchdog's own `#checkHeartbeats` also requires a truthy handle
 * to act. `host.onExit` is wired here -- before `host.reset()` is even called -- specifically so a crash during
 * this window is reported the same way `WebRunSession#onCrash` reports one later, instead of being invisible until
 * the timeout fires.
 *
 * `timeoutMs` is `WEBVIEW_READY_TIMEOUT_MS` by default (or `deps.webviewReadyTimeoutMs`) -- see that constant's own
 * doc comment for why it is no longer `expandTimeoutMs`.
 *
 * M4 T9c (a CodeRabbit finding on PR #3, verified before acting on it): `host.onMessage` is deliberately NOT
 * subscribed until `host.reset()` itself has resolved -- i.e., until *this* reload's own bootstrap injection has
 * actually happened. An earlier version of this function subscribed before calling `reset()`, which let a `ready`
 * left over from the tab's *previous* page -- still in flight across the UI<->Main RPC boundary at the exact
 * moment this `reset()` reloads that page away -- satisfy a wait it does not belong to: `WebToHostMessage` carries
 * no generation/epoch of its own, so nothing else distinguishes "this reload's ready" from "the last one's, delayed
 * in transit". That is a real, if narrow, race: a persistent webview (Task 8's invariant) is reset()'d again on
 * every run on the same tab, so an in-flight straggler from run N has a window to be mistaken for run N+1's ready.
 * `reset()` resolving is the *earliest* moment a genuine ready for this generation could even have been sent (the
 * bootstrap has only just been injected), so deferring the subscription until then closes the gap structurally --
 * no generation token, no wire-format change, just not listening before there is anything genuine to hear. `onExit`
 * and the timeout remain armed for the whole window, including while `reset()` itself is still in flight.
 */
async function waitForReady(
  host: WebviewHost,
  webviews: WebviewSource,
  tabId: string,
  timeoutMs: number,
  runtime: WebRuntimeId,
): Promise<void> {
  let settled = false;
  await new Promise<void>((resolve, reject) => {
    let unsubMessage = () => {};
    const unsubExit = host.onExit(() => {
      if (settled) return;
      settled = true;
      unsubMessage();
      clearTimeout(timer);
      reject(new Error(`Web runner's webview exited before it reported ready (tab ${tabId}).`));
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      unsubMessage();
      unsubExit();
      webviews.destroy(tabId);
      reject(new Error(`Web runner's webview never reported ready within ${timeoutMs}ms (tab ${tabId}).`));
    }, timeoutMs);
    host
      .reset(runtime)
      .then(() => {
        if (settled) return; // onExit or the timeout already settled this while reset() was still in flight.
        unsubMessage = host.onMessage((message) => {
          if (message.type !== "ready" || settled) return;
          settled = true;
          unsubMessage();
          unsubExit();
          clearTimeout(timer);
          resolve();
        });
      })
      .catch((error: unknown) => {
        if (settled) return;
        settled = true;
        unsubMessage();
        unsubExit();
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
  });
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
  /** Fix round 1 (security): built lazily, only the first time this session actually sees a `fetchRequest` -- most
   *  runs (and every `"browser"` session, ever) never need one. */
  #fetchRunner: WebFetchRunner | null = null;
  /** Task 11: built lazily for the same reason `#fetchRunner` is -- most runs never make a bridged Node call. */
  #nodeRunner: WebNodeRunner | null = null;

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
          this.#settleStop();
          return;
        }
        this.#terminal = "killed";
        this.#killWebview();
        this.#settleStop();
      }, this.deps.stopGraceMs ?? 500);
    });
  }

  /**
   * Settles a pending `stop()` exactly once, whatever actually ended the run.
   *
   * Mirrors `BunRunSession#settleStop` (`bun-adapter.ts`), which exists for this same defect. `stop()` used to
   * resolve only on the page's own `state: "stopped"` or on the escalation timer -- so a `kill()` arriving first
   * cleared that timer and retired the handle with nothing ever calling the stored resolver, and the promise
   * `stop()` returned never settled. Invisible today only because the sole caller discards it
   * (`../runs/run-coordinator.ts`'s `void run.handle.stop()`); the first caller to await it would hang.
   */
  #settleStop(): void {
    const settle = this.#stopSettle;
    this.#stopSettle = undefined;
    settle?.();
  }

  kill(): void {
    clearTimeout(this.#stopTimer);
    if (this.#terminal) return;
    this.#terminal = "killed";
    this.#killWebview();
  }

  /** Task 15 (spec §5.12, EX-35): forwarded straight to the page, page-lifetime not run-scoped (`bootstrap.ts`
   * applies it immediately, whether or not anything is currently playing). A stray call after the handle is
   * retired is a harmless no-op -- the webview is gone either way. */
  mute(muted: boolean): void {
    if (this.#terminal) return;
    this.host.send({ type: "mute", muted });
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
   *
   * Fix round 1 (C1): reports `sink.state("killed")` -- mirroring `BunRunSession`'s `#reportTerminal("killed")`
   * (`bun-adapter.ts`) -- before retiring the handle. Without this, `RunCoordinator.stop()` (which only sets
   * `"stopping"` and relies entirely on the adapter to report a terminal state) never learned that an escalated
   * Stop had actually ended the run: `#checkHeartbeats` only watches `"evaluating"`/`"settled"`, so the stale
   * `"stopping"` was never corrected and the tab spun forever with no "Run killed" entry. Explicit Kill happened to
   * work only because `RunCoordinator.kill()` sets `"killed"` itself unconditionally -- an accident of that one
   * call site, not a guarantee this class could rely on.
   */
  #killWebview(): void {
    this.deps.webviews.destroy(this.run.tabId);
    void this.deps.webviews
      .ensure({ tabId: this.run.tabId, workingDirectory: this.run.workingDirectory })
      .catch(() => {});
    this.sink.state("killed");
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
    // The one choke point every terminal path goes through (Kill pre-empting a pending Stop, a crash, the page's
    // own "stopped"), so a caller awaiting `stop()` is never left hanging on a run that is already over.
    this.#settleStop();
    for (const settle of [...this.#pendingExpands.values()]) settle(null);
    this.#pendingExpands.clear();
    // Fix round 1: a run that retires mid-request must not leave Main still talking to a server on the user's
    // behalf for a page nothing is listening to anymore.
    this.#fetchRunner?.abortAll();
    // Task 11: the same rule for child processes -- a run that retires mid-command must not leave Main running a
    // process on the user's behalf for a page nothing is listening to anymore.
    this.#nodeRunner?.abortAll();
    this.#unsubMessage();
    this.#unsubExit();
    this.deps.runLock.remove(this.run.runId);
    this.sink.exited();
  }

  /** Fix round 2 (nit 4): the one place `this.deps.redact`'s no-op fallback is computed -- `#fetchRunnerFor()` and
   *  `#onMessage`'s `"fetchRequest"` refusal both used to repeat `this.deps.redact ?? ((text) => text)` inline. */
  #redact(text: string): string {
    return (this.deps.redact ?? ((t: string) => t))(text);
  }

  /**
   * Fix round 1 (security): the fail-closed gate for `browser-node`'s fetch proxy, moved here from a `tabId`
   * lookup a `browser` tab could forge. `this.deps.runtime` is fixed per `WebAdapter` instance (one adapter per
   * runtime, `main-services.ts`'s `webAdapterDeps`) and this session belongs to exactly one tab's one webview
   * connection -- there is no field to spoof, because nothing here is read from the message.
   */
  #fetchRunnerFor(): WebFetchRunner {
    if (!this.#fetchRunner) {
      this.#fetchRunner = createWebFetchRunner({
        send: {
          head: (payload) => this.host.send({ type: "fetchHead", ...payload }),
          chunk: (payload) => this.host.send({ type: "fetchChunk", ...payload }),
          end: (payload) => this.host.send({ type: "fetchEnd", ...payload }),
          error: (payload) => this.host.send({ type: "fetchError", ...payload }),
        },
        redact: (text) => this.#redact(text),
        log: this.deps.log ?? (() => {}),
        ...(this.deps.webFetch ? { fetch: this.deps.webFetch } : {}),
      });
    }
    return this.#fetchRunner;
  }

  /**
   * Task 11 (spec §5.13): the `browser-node` Node bridge's runner, gated exactly the way `#fetchRunnerFor` is.
   * The tab's working directory comes from `this.run` -- the run Main itself prepared -- never from the message,
   * so a page cannot name a scope it was not given.
   */
  #nodeRunnerFor(): WebNodeRunner {
    if (!this.#nodeRunner) {
      this.#nodeRunner = createWebNodeRunner({
        send: {
          result: (payload) => this.host.send({ type: "nodeResult", ...payload }),
          error: (payload) => this.host.send({ type: "nodeError", ...payload }),
          stdout: (payload) => this.host.send({ type: "nodeStdout", ...payload }),
          stderr: (payload) => this.host.send({ type: "nodeStderr", ...payload }),
          exit: (payload) => this.host.send({ type: "nodeExit", ...payload }),
        },
        redact: (text) => this.#redact(text),
        log: this.deps.log ?? (() => {}),
        // The parity expression, mirroring `../runs/runner-config.ts`'s own `workingDirectory ?? dataDir`. Kept
        // here, in the one place that knows both, so the two runtimes cannot drift apart silently.
        baseDirectory: this.run.workingDirectory ?? this.deps.dataDir ?? this.deps.runsDir,
        // Task 9f item 6: the same layering a `bun` tab's command gets, rather than Main's raw `process.env`.
        ...(this.deps.nodeEnvironment ? { baseEnvironment: this.deps.nodeEnvironment(this.run.workingDirectory) } : {}),
      });
    }
    return this.#nodeRunner;
  }

  #onMessage(message: WebToHostMessage): void {
    switch (message.type) {
      case "ready":
        // Consumed by `start()`'s own one-shot listener before this session exists; a stray repeat is ignored.
        return;
      case "heartbeat":
        this.sink.heartbeat();
        return;
      case "events": {
        // The same defect `case "state"` was fixed for below, in the same message loop and for the same structural
        // reason: the page stamps every batch with the run it belongs to (`bootstrap.ts`'s `EventBuffer` sink sends
        // `{ type: "events", runId: message.runId, events }`), but this session used to ignore that field and relay
        // whatever arrived. The webview is persistent (Task 8's invariant) and a session only unwires itself once it
        // reaches `stopped`, so a run that finished `idle`/`settled` is still listening when the next run starts and
        // *both* sessions see every batch -- a stray console line from a superseded run lands in the live run's
        // output. Under Auto Run, where runs overlap on every keystroke, that is a console that shows output the
        // code being edited never produced.
        //
        // Dropped ahead of every side effect in the case, checked one by one the way `case "state"`'s gate was:
        //   * `this.#terminal` is a guard, not a side effect -- but the identity check goes first anyway, so this
        //     case reads the same way as `state` below (compare identity, then act).
        //   * `this.run.mapEvent(event)` remaps a raw, generated-position event through *this* run's source map.
        //     A stranger's event mapped through it reports line numbers from the wrong bundle -- so the drop has to
        //     precede the mapping, not merely the relay.
        //   * `this.sink.events(...)` is the relay itself: the user-visible half of the defect.
        // Unlike `state`, nothing here releases a lock, settles a pending `stop()` or retires a handle, so the drop
        // cannot wedge a live run the way a too-eager guard on `state` would. Nothing is stranded either: the run
        // the batch really belongs to is wired to this same host and relays it on its own session.
        if (message.runId !== this.run.runId) return;
        if (this.#terminal) return;
        this.sink.events(message.events.map((event) => this.run.mapEvent(event)));
        return;
      }
      case "fetchRequest":
        // The defining refusal (fix round 1): enforced against `this.deps.runtime`, which this session's own
        // `WebAdapter` was constructed with -- never against anything the message supplies. A `browser` tab's
        // page (including one that forged this envelope directly over `__electrobunSendToHost`, bypassing
        // `fetch-proxy.ts` entirely) is refused here exactly the same way, because there is no `tabId` left to
        // forge: this session IS the tab.
        if (this.deps.runtime !== "browser-node") {
          this.host.send({
            type: "fetchError",
            id: message.id,
            message: this.#redact(
              `Fetch is only routed through JSLab for the "browser-node" runtime; this tab is "${this.deps.runtime}".`,
            ),
          });
          return;
        }
        this.#fetchRunnerFor().request(message.id, {
          url: message.url,
          method: message.method,
          headers: message.headers,
          body: message.body,
        });
        return;
      case "fetchAbort":
        this.#fetchRunner?.abort(message.id);
        return;
      case "nodeCall":
        // Task 11: the same structural gate the `fetchRequest` case documents. A `browser` tab has no Node
        // builtins at all, so a `nodeCall` from one can only be forged -- and it is refused against
        // `this.deps.runtime`, which this session's adapter was constructed with, never against the message.
        if (this.deps.runtime !== "browser-node") {
          this.host.send({
            type: "nodeError",
            id: message.id,
            name: "JSLabUnsupportedError",
            message: this.#redact(
              `Node APIs are only bridged for the "browser-node" runtime; this tab is "${this.deps.runtime}".`,
            ),
          });
          return;
        }
        this.#nodeRunnerFor().call(message.id, {
          id: message.id,
          module: message.module,
          method: message.method,
          args: message.args,
        });
        return;
      case "nodeAbort":
        this.#nodeRunner?.abort(message.id);
        return;
      case "state": {
        // The user-reported defect (M4), gated the same way T9e gates `ready`/`exit` (`webview-source.ts`):
        // compare the identity the message carries against the identity of the thing receiving it, and drop a
        // mismatch. The page stamps every state with the run it belongs to (`bootstrap.ts`'s `setState`) and this
        // session belongs to exactly one run -- but the webview is persistent and a session only unwires itself
        // once it reaches `stopped`, so a run that finished `idle`/`settled` is still listening when the next run
        // starts and *both* sessions see every message. Relaying one blindly reported run N's handle count
        // against run N+1, parking the status bar on "Running: N active handles" for a run already over (`settled`
        // is in the UI's `BUSY_STATES`); under Auto Run, where runs overlap on every keystroke, that stuck.
        //
        // Dropped ahead of every side effect below, because each is scoped to `this.run`, never to the message:
        // `#settleStop` settles *this* run's pending `stop()`, `runLock.remove` releases *this* run's lock, and
        // `#retireHandle` retires *this* run's handle. Running any of them on a stranger's state is the wedge
        // rather than the cure -- it would release a live run's lock and retire its handle mid-run. Nothing is
        // stranded by the drop either: the run the message really belongs to is wired to this same host and
        // settles, unlocks and retires itself on its own session.
        if (message.runId !== this.run.runId) return;
        if (message.state === "stopped") {
          clearTimeout(this.#stopTimer);
          this.#settleStop();
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
      case "audio":
        this.sink.audio?.(message.active);
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
    this.sink.events([webviewCrashEvent()]);
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
      const host = await deps.webviews.ensure({ tabId: run.tabId, workingDirectory: run.workingDirectory });
      if (run.isCancelled()) return deadHandle(run.runId);

      // Spec §5.12 steps 1-2 ("Main sends runner.reset... the page reloads"), decision 1: every run gets a fresh
      // realm/DOM via reload, not just Stop/Kill -- see the report for why this is safe without an uninstall path.
      // Fix round 1 (C2): bounded and crash-aware -- see `waitForReady`'s own doc comment.
      await waitForReady(
        host,
        deps.webviews,
        run.tabId,
        deps.webviewReadyTimeoutMs ?? WEBVIEW_READY_TIMEOUT_MS,
        deps.runtime,
      );
      if (run.isCancelled()) return deadHandle(run.runId);

      // Ledger ruling R-M4-T7-GAP-1 (from Task 7's re-review). From here until the session below wires its own
      // listeners, the webview is otherwise unobserved -- and everything in between (the entry write, the app
      // build, the cache read, the vendor build) takes real time. A crash inside that window used to report
      // nothing at all: no handle exists yet (`sink.attached()` is further down), so `RunCoordinator.stop()` and
      // `kill()` are both no-ops, and `#checkHeartbeats` skips a run with no handle too -- the tab span forever
      // with no way out. `BunAdapter` has no equivalent window: it wires immediately after taking its runner, with
      // no bundling in between. The listener reports the same terminal pair `WebRunSession#onCrash` reports once a
      // session exists, and is removed again the moment the session's own listener takes over, so a crash is never
      // reported twice.
      let crashed = false;
      const unsubCrash = host.onExit(() => {
        if (crashed) return;
        crashed = true;
        sink.events([webviewCrashEvent()]);
        sink.state("failed");
      });

      let code: string | null = null;
      try {
        const dir = join(deps.runsDir, run.tabId);
        await mkdir(dir, { recursive: true });
        if (run.isCancelled() || crashed) return deadHandle(run.runId);
        const entryPath = join(dir, `entry-${run.runId}.mjs`);
        await Bun.write(entryPath, run.code);
        if (run.isCancelled() || crashed) return deadHandle(run.runId);
        // Fix round 1 (M1): mirrors `BunAdapter.start()`'s `cleanupEntries` call -- fire-and-forget, never blocks
        // this run on deleting a previous one's stale entry file.
        void cleanupEntries(dir, basename(entryPath));

        // Fix round 1 (I1): moved here, immediately before the app build is invoked -- the previous placement (the
        // very first statement of `start()`) ran before `ensure()`, before the whole (now-bounded, but still real)
        // reset/ready round trip, and before the entry write, leaving a much wider TOCTOU gap than the comment
        // claimed. This re-verifies the scope directly against the filesystem with nothing else awaited before the
        // build reads `<workingDirectory>/node_modules` -- as tight a gap as an inherently-async check (Web has no
        // synchronous `runner.cwd`-like property to compare, unlike `BunAdapter`) can get.
        const workingDirectoryGone =
          run.workingDirectory !== null && !(await (deps.directoryExists ?? directoryExists)(run.workingDirectory));
        // Fix round 1 (M3): the crash check gates the throw, rather than following it. A crash landing during the
        // check above has already reported a terminal state; throwing here as well would have `RunCoordinator`
        // report a second one (`#failWorkingDirectory`). Every other step in this window already checks first.
        if (run.isCancelled() || crashed) return deadHandle(run.runId);
        if (workingDirectoryGone) {
          throw new WorkingDirectoryMismatchError(run.workingDirectory as string);
        }

        // The app chunk: the tab's own code, rebuilt every run, never cached under any circumstances (Task 8a).
        const app = await (deps.bundle ?? bundleAppForWeb)({
          entry: entryPath,
          runtime: deps.runtime,
          workingDirectory: run.workingDirectory,
          packagesNodeModules: deps.packagesNodeModules,
          dataDir: deps.dataDir ?? deps.runsDir,
        });
        if (run.isCancelled() || crashed) return deadHandle(run.runId);
        if ("error" in app) {
          sink.events([bundleErrorEvent(app.error.message, app.error.line, app.error.column, app.error.codeFrame)]);
          sink.state("failed");
          return deadHandle(run.runId);
        }

        // The vendor chunk: the only half a cache hit may stand in for, and only on an exact key match.
        let vendorCode: string | null = null;
        if (app.imports.length > 0) {
          const key = app.vendorCacheable ? await vendorKeyFor(deps, app.imports, run.workingDirectory) : null;
          const cached = key ? await deps.vendorCache.get(key).catch(() => null) : null;
          if (run.isCancelled() || crashed) return deadHandle(run.runId);
          if (cached && vendorChunkFitsTab(cached, run.workingDirectory, deps.packagesNodeModules)) {
            vendorCode = cached.code;
          } else {
            const vendor = await (deps.bundleVendor ?? bundleVendorForWeb)({
              imports: app.imports,
              runtime: deps.runtime,
              workingDirectory: run.workingDirectory,
              packagesNodeModules: deps.packagesNodeModules,
              dataDir: deps.dataDir ?? deps.runsDir,
            });
            if (run.isCancelled() || crashed) return deadHandle(run.runId);
            if ("error" in vendor) {
              sink.events([
                bundleErrorEvent(vendor.error.message, vendor.error.line, vendor.error.column, vendor.error.codeFrame),
              ]);
              sink.state("failed");
              return deadHandle(run.runId);
            }
            vendorCode = vendor.code;
            // Fix round 1 (C1): the vendor build's own verdict gates the write as well as the app build's. The app
            // build only saw the tab's direct imports; this one saw the whole transitive closure, and a chunk
            // holding working-directory code at any depth is unkeyable -- storing it would let a *different* tab,
            // one with no working directory at all, hit the same key and run this tab's project code.
            // Fire-and-forget otherwise, exactly as the write-only population was: a run never waits on the cache,
            // and a failed write only costs the next run a rebuild.
            if (key && vendor.vendorCacheable) {
              void deps.vendorCache.set(key, { code: vendor.code, map: vendor.map }, vendor.closure).catch(() => {});
            }
          }
        }
        code = joinVendorAndApp(vendorCode, app.code);
      } finally {
        unsubCrash();
      }
      if (crashed || code === null) return deadHandle(run.runId);

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
      host.send({
        type: "run",
        runId: run.runId,
        code,
        settings: { maxEntries: run.maxEntries },
        muted: run.muted ?? false,
      });
      return session;
    },
  };
}

async function readBunLockFile(path: string): Promise<string> {
  return Bun.file(path).text();
}

/**
 * The vendor chunk's cache key (spec §5.12): the `bun.lock` hash plus the import set. Null means "don't touch the
 * cache at all for this run" -- there is no `bun.lock` yet (no packages installed for this profile), so there is
 * nothing to pin versions with.
 */
async function vendorKeyFor(
  deps: WebAdapterDeps,
  imports: readonly string[],
  workingDirectory: string | null,
): Promise<string | null> {
  try {
    const lockText = await (deps.readBunLock ?? readBunLockFile)(deps.bunLockPath);
    return vendorCacheKey(hashBunLock(lockText), imports, deps.runtime, workingDirectory);
  } catch {
    return null;
  }
}

/**
 * Fix round 2: the read-side half of the verdict the write side already had.
 *
 * The cache key is the `bun.lock` hash plus the direct import set -- measured to be **identical** for a tab with a
 * working directory and one without. So a chunk stored by any other tab (or any other project) with the same
 * lockfile and the same direct imports is offered to this tab on its **very first run**; nothing has to have
 * changed over time, and a fresh profile is not safe by construction. If one of the packages that chunk was built
 * from would resolve out of *this* tab's working directory, serving it runs the shared-folder copy in place of
 * the user's own -- the exact mirror of the cross-tab hazard the write path refuses to create.
 *
 * So the stored closure is re-resolved here, in this tab's context, through the same two functions the builds use.
 * Complete, because a working-directory copy can only shadow a specifier some package actually asks for, and the
 * closure is exactly that set. Cheap, because it resolves rather than bundles. Fail-closed on `null`: an entry
 * whose provenance was never recorded (an index rebuilt from filenames) is unusable for a tab that has a working
 * directory at all, rather than assumed innocent.
 *
 * A tab with no working directory needs no check: there is no second `node_modules` for anything to resolve out of.
 *
 * Task 9f (item 4): that last sentence is only sound because the **key** now carries the working directory too. It
 * did not before -- and a `browser-node` vendor chunk can embed a `process` snapshot built from the tab's working
 * directory (its `cwd`, and the `NODE_PATH` `runnerEnvironment` derives from it) without that ever showing up in
 * the resolved closure, because `process` is a virtual module rather than a resolved package. So a chunk carrying
 * one tab's snapshot hashed to the same key as any other tab's and was served straight to it, and this guard waved
 * it through on exactly the branch below. Keying on the working directory is what closes that; this stays as the
 * shadowing check it was written to be.
 */
function vendorChunkFitsTab(
  cached: CachedVendorChunk,
  workingDirectory: string | null,
  packagesNodeModules: string,
): boolean {
  if (workingDirectory === null) return true;
  if (!cached.closure) return false;
  return !cached.closure.some((specifier) => {
    const resolved = resolveBareSpecifier(specifier, { workingDirectory, packagesNodeModules });
    // Unresolvable now means the rebuild below will fail and report it properly; it is not a shadowing case.
    // A package excluded by a `browser` map still carries the path it resolved from, so provenance stays exact.
    return resolved !== undefined && resolvedFromWorkingDirectory(resolved.path, workingDirectory);
  });
}

/** The one terminal error event a dead webview produces, wherever it is noticed from. */
function webviewCrashEvent(): RunEvent {
  return {
    kind: "error",
    phase: "runner",
    name: "RuntimeError",
    message: "Web runner exited unexpectedly.",
    stack: [],
    seq: Number.MAX_SAFE_INTEGER,
    t: Date.now(),
  };
}
