import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { EncodedValue, RunEvent, RunState } from "@jslab/rpc-schema";
import type { Runtime } from "@jslab/shared";
import type { BuildOptions, Diagnostic, Language, TransformOptions, TransformResult } from "@jslab/transform";
import {
  type PreparedRun,
  type RunEventSink,
  type RunHandle,
  type RuntimeAdapter,
  WorkingDirectoryMismatchError,
} from "../runtimes/adapter";
import { createBunAdapter, type SpareSource } from "../runtimes/bun-adapter";
import { createRuntimeRegistry, type RuntimeRegistry } from "../runtimes/registry";
import { strings } from "../strings";
import { createEventMapper } from "./event-mapper";

export interface RunStartRequest {
  tabId: string;
  code: string;
  language: Language;
  logpoints: number[];
  /** The runtime this run executes on (spec §5.2). */
  runtime?: Runtime;
  /** The tab's working directory, or null (spec §5.3). */
  workingDirectory?: string | null;
  /** `__filename`'s base name (scriptFileName). */
  scriptName?: string;
  /** Task 15 (spec §5.12, EX-35): the tab's saved mute preference (`session.tabs[tabId].layout.muted`). */
  muted?: boolean;
}

export interface RunnerSettings {
  autoLog: boolean;
  loopProtection: boolean;
  loopProtectionMaxIterations: number;
  maxEntries: number;
  unresponsiveTimeoutMs: number;
  build?: BuildOptions;
}

export interface RunCoordinatorDeps {
  transform(source: string, options: TransformOptions): Promise<TransformResult>;
  /**
   * The Bun spare pool. `RunCoordinator` no longer talks to it (or to `BunRunnerProcess`) directly -- every run goes
   * through the `RuntimeAdapter` seam (spec §5.1, this task). This stays a required field only so a caller that
   * builds a `RunCoordinator` straight from a `SparePool` (this file's own test harness included) keeps working
   * unchanged: absent an explicit `runtimes` registry below, one is built from exactly this and `runsDir`.
   */
  spares: SpareSource & { dispose(): void };
  runsDir: string;
  settings(): RunnerSettings;
  onEvents(tabId: string, runId: string, events: RunEvent[]): void;
  onState(tabId: string, runId: string, state: RunState, activeHandles?: number): void;
  onDiagnostics(tabId: string, runId: string, diagnostics: Diagnostic[]): void;
  /** Task 15 (spec §5.12, EX-35): a running web tab's audio-active state changed. Optional: `main.ts`'s own test
   * harness and any caller that doesn't care about the indicator can omit it. */
  onAudio?(tabId: string, active: boolean): void;
  runLock: { add(runId: string): void; remove(runId: string): void };
  watchdogIntervalMs?: number;
  stopGraceMs?: number;
  idleRunnerTtlMs?: number;
  expandTimeoutMs?: number;
  directoryExists?(path: string): Promise<boolean>;
  exitGraceMs?: number;
  /**
   * The runtime registry (spec §5.1, Task 2). When omitted, `RunCoordinator` builds a Bun-only one from `spares`/
   * `runsDir`/`runLock` above (R-M4-T1-OPTIONAL-1's undefined-runtime default resolves to it either way).
   * `main-services.ts` builds and passes its own explicitly, ready for Task 7 to add a `web` entry to it.
   */
  runtimes?: RuntimeRegistry;
}

interface ActiveRun {
  runId: string;
  tabId: string;
  state: RunState;
  handle: RunHandle | null;
  cancelled: boolean;
  // The last time this run's runtime reported it was alive (any adapter reporting heartbeats, not just Bun's IPC
  // ones); unresponsive-detection and recovery are generic Main-level concerns (spec §5.11), owned here regardless
  // of which adapter is running the code.
  lastHeartbeatAt: number;
  // The state to restore when recovering from "unresponsive" (I5): the run may have gone unresponsive from
  // "settled", not just "evaluating".
  resumeState?: RunState;
  activeHandles?: number;
}

// "transpiling" is included because a runner can already be assigned (and the "run" message already sent) while
// the coordinator's own state is still "transpiling" -- the "evaluating" state event needs an IPC round trip to
// arrive. Stop must still work during that window (I1).
const STOPPABLE_STATES: ReadonlySet<RunState> = new Set(["transpiling", "evaluating", "settled", "unresponsive"]);

/** Maximum events per `run.events` message sent to the UI (spec §4.2, verified by M0-S7). */
const UI_BATCH_EVENTS = 200;

/** The error name of a run whose working directory is gone; the UI offers Change… for it (spec §12.2). */
export const WORKING_DIRECTORY_ERROR = "WorkingDirectoryError";

/** How long Main waits after exitRequested before ending a runner that didn't exit (the runner's own drain is 2 s). */
export const EXIT_KILL_GRACE_MS = 2500;

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export class RunCoordinator {
  readonly #runs = new Map<string, ActiveRun>();
  /**
   * Spec §7.4: the source and options of each tab's most recent **successful** transform, so Show Transpiled
   * Output can hand back that run's Babel output, and can re-derive it without instrumentation (R-M5a-3).
   * One entry per tab, replaced on every successful transform and dropped with the tab.
   */
  readonly #transpiled = new Map<string, { source: string; options: TransformOptions; code: string }>();
  readonly #registry: RuntimeRegistry;
  readonly #watchdog: ReturnType<typeof setInterval>;

  constructor(private readonly deps: RunCoordinatorDeps) {
    // This fallback exists so a caller that hands RunCoordinator a SparePool directly (this file's own test
    // harness, most notably) keeps working with no `runtimes` field at all; production (main-services.ts) always
    // builds and passes its own registry explicitly instead, forwarding these same tuning knobs itself.
    this.#registry =
      deps.runtimes ??
      createRuntimeRegistry({
        bun: createBunAdapter({
          spares: deps.spares,
          runsDir: deps.runsDir,
          runLock: deps.runLock,
          stopGraceMs: deps.stopGraceMs,
          idleRunnerTtlMs: deps.idleRunnerTtlMs,
          expandTimeoutMs: deps.expandTimeoutMs,
          exitGraceMs: deps.exitGraceMs ?? EXIT_KILL_GRACE_MS,
        }),
      });
    this.#watchdog = setInterval(() => this.#checkHeartbeats(), deps.watchdogIntervalMs ?? 500);
  }

  start(request: RunStartRequest): { runId: string } {
    this.#supersede(request.tabId);
    const run: ActiveRun = {
      runId: crypto.randomUUID(),
      tabId: request.tabId,
      state: "transpiling",
      handle: null,
      cancelled: false,
      lastHeartbeatAt: Date.now(),
    };
    this.#runs.set(request.tabId, run);
    this.#setState(run, "transpiling");
    void this.#execute(run, request);
    return { runId: run.runId };
  }

  stop(tabId: string): void {
    const run = this.#runs.get(tabId);
    if (!run) return;
    if (!run.handle) {
      // No runner has been taken yet: cancel outright so #execute bails out (and kills whatever the adapter's
      // start() returns later) instead of starting anything.
      if (run.state === "transpiling") {
        run.cancelled = true;
        this.#setState(run, "stopped");
      }
      return;
    }
    if (!STOPPABLE_STATES.has(run.state)) return;
    this.#setState(run, "stopping");
    void run.handle.stop();
  }

  kill(tabId: string): void {
    const run = this.#runs.get(tabId);
    if (!run?.handle) return;
    run.handle.kill();
    this.deps.runLock.remove(run.runId);
    // A stopped run is already being recycled (R-M1-18): its runner is gone either way, and it stays "stopped".
    if (run.state === "stopped") return;
    this.#setState(run, "killed");
  }

  /** The user chose "Wait" in the unresponsive dialog. */
  wait(tabId: string): void {
    const run = this.#runs.get(tabId);
    if (!run?.handle || run.state !== "unresponsive") return;
    run.lastHeartbeatAt = Date.now();
    this.#setState(run, run.resumeState ?? "evaluating", run.activeHandles);
  }

  expand(tabId: string, runId: string, handleId: string): Promise<EncodedValue | null> {
    const run = this.#runs.get(tabId);
    if (!run?.handle || run.runId !== runId || run.state === "killed") return Promise.resolve(null);
    return run.handle.expand(handleId);
  }

  /**
   * Spec §7.4: the latest Babel output for a tab. `hideInstrumentation` re-runs the same transform with Auto Log,
   * logpoints and loop protection off (R-M5a-3) rather than stripping `__jl` calls out of generated code, which
   * cannot be done correctly. The transform host is LRU-cached, so the second call is cheap and repeatable.
   */
  async transpiled(tabId: string, hideInstrumentation: boolean): Promise<{ code: string } | null> {
    const entry = this.#transpiled.get(tabId);
    if (!entry) return null;
    if (!hideInstrumentation) return { code: entry.code };
    const plain = await this.deps.transform(entry.source, {
      ...entry.options,
      autoLog: false,
      logpoints: [],
      loopProtection: false,
    });
    return plain.ok ? { code: plain.code } : null;
  }

  /**
   * Task 15 (spec §5.12, EX-35): live-toggles mute for whatever is currently running on this tab. A harmless no-op
   * when nothing is running, or when the running adapter has no concept of mute (`RunHandle.mute` is optional) --
   * the tab's saved preference still applies at the *start* of its next run either way (`#execute`'s `muted`).
   */
  mute(tabId: string, muted: boolean): void {
    this.#runs.get(tabId)?.handle?.mute?.(muted);
  }

  disposeTab(tabId: string): void {
    this.#supersede(tabId);
    this.#runs.delete(tabId);
    this.#transpiled.delete(tabId);
    // Every registered adapter, not just Bun's. `#registry.get(undefined)` always resolves to the Bun adapter by
    // design, so this used to call `BunAdapter.dispose` even for a browser tab and never `WebAdapter.dispose` --
    // the tab's webview was never destroyed on close and Main's own entry was never dropped (leaking
    // `nextGeneration` and leaving Main's teardown entirely dependent on the UI reporting an exit). The comment
    // this replaces was stale: M4 *did* register per-runtime web adapters. There is no runtime to route by here --
    // the run is already gone, and a tab can switch runtime mid-session, so one tabId may hold resources in more
    // than one adapter -- so every adapter is told. Disposing a tab an adapter never saw is a no-op in all of them.
    for (const adapter of this.#registry.all()) void adapter.dispose(tabId);
  }

  dispose(): void {
    clearInterval(this.#watchdog);
    for (const tabId of [...this.#runs.keys()]) this.disposeTab(tabId);
    // `RuntimeAdapter` has no whole-pool teardown (only per-tab `dispose`/`invalidate`): a background spare warmed
    // for a tab that never ran anything (via `prepare`/`setActiveTab`, outside this class) would otherwise leak.
    this.deps.spares.dispose();
  }

  async #execute(run: ActiveRun, request: RunStartRequest): Promise<void> {
    const adapter = this.#registry.get(request.runtime);
    try {
      const workingDirectory = request.workingDirectory ?? null;
      if (workingDirectory && !(await (this.deps.directoryExists ?? directoryExists)(workingDirectory))) {
        this.#failWorkingDirectory(run, adapter, workingDirectory);
        return;
      }
      const settings = this.deps.settings();
      const transformOptions: TransformOptions = {
        language: request.language,
        autoLog: settings.autoLog,
        loopProtection: settings.loopProtection,
        loopProtectionMaxIterations: settings.loopProtectionMaxIterations,
        logpoints: request.logpoints,
        ...(settings.build ? { build: settings.build } : {}),
        ...(workingDirectory
          ? {
              workingDirectory: {
                dir: workingDirectory,
                filename: join(workingDirectory, request.scriptName ?? "Untitled.ts"),
              },
            }
          : {}),
      };
      const result = await this.deps.transform(request.code, transformOptions);
      if (!this.#isCurrent(run)) return;
      if (result.ok) {
        this.#transpiled.set(run.tabId, { source: request.code, options: transformOptions, code: result.code });
      }
      this.deps.onDiagnostics(run.tabId, run.runId, result.diagnostics);

      if (!result.ok) {
        const d = result.diagnostics[0];
        this.deps.onEvents(run.tabId, run.runId, [
          {
            kind: "error",
            phase: "transpile",
            name: "SyntaxError",
            message: d?.message ?? "Unable to compile",
            line: d?.line,
            column: d?.column,
            ...(d?.codeFrame ? { codeFrame: d.codeFrame } : {}),
            stack: [],
            seq: 1,
            t: Date.now(),
          },
        ]);
        this.#setState(run, "failed");
        return;
      }

      // The entry's basename is deterministic from the runId alone (spec §5.3's per-run entry naming), so the
      // mapper can be built here without knowing how (or whether) an adapter delivers the code to its runtime.
      const mapper = createEventMapper(result.map, `entry-${run.runId}.mjs`, new Set(request.logpoints));
      const preparedRun: PreparedRun = {
        runId: run.runId,
        tabId: run.tabId,
        code: result.code,
        maxEntries: settings.maxEntries,
        workingDirectory,
        mapEvent: (event) => mapper(event),
        isCancelled: () => !this.#isCurrent(run),
        muted: request.muted ?? false,
      };
      const sink: RunEventSink = {
        attached: (handle) => {
          if (!this.#isCurrent(run)) {
            handle.kill();
            return;
          }
          run.handle = handle;
          // Task 9d: `lastHeartbeatAt` was stamped when the run was created, but transpiling and bundling happen
          // before a runtime exists to send a heartbeat. `#checkHeartbeats` skips a run until its handle attaches,
          // which defers the judgement without refreshing the stale stamp -- so the instant this fired, a
          // creation-time stamp already older than `unresponsiveTimeoutMs` was judged and the user saw the
          // unresponsive prompt for a run that had only just begun. The runtime is live as of right now.
          run.lastHeartbeatAt = Date.now();
        },
        events: (events) => {
          if (!this.#isCurrent(run)) return;
          // Re-batch for the UI (spec §4.2): at most 200 events per run.events message, whatever the adapter sent.
          for (let i = 0; i < events.length; i += UI_BATCH_EVENTS) {
            this.deps.onEvents(run.tabId, run.runId, events.slice(i, i + UI_BATCH_EVENTS));
          }
        },
        state: (state, activeHandles) => {
          if (!this.#isCurrent(run)) return;
          this.#setState(run, state, activeHandles);
        },
        heartbeat: () => {
          if (!this.#isCurrent(run)) return;
          run.lastHeartbeatAt = Date.now();
          if (run.state === "unresponsive") this.#setState(run, run.resumeState ?? "evaluating", run.activeHandles);
        },
        exited: () => {
          // The runner is gone: Kill, expand and quit must not act on it again (or signal its possibly reused pid).
          run.handle = null;
        },
        audio: (active) => {
          if (!this.#isCurrent(run)) return;
          this.deps.onAudio?.(run.tabId, active);
        },
      };

      let handle: RunHandle;
      try {
        handle = await adapter.start(preparedRun, sink);
      } catch (error) {
        if (!this.#isCurrent(run)) return;
        this.deps.runLock.remove(run.runId);
        if (error instanceof WorkingDirectoryMismatchError) {
          this.#failWorkingDirectory(run, adapter, error.workingDirectory);
        } else {
          this.#runnerError(run, error instanceof Error ? error.message : String(error));
        }
        return;
      }
      if (!this.#isCurrent(run)) {
        handle.kill();
        return;
      }
      // No `run.handle = handle` here: `sink.attached()` already set it, as soon as a controllable runner existed
      // (F1, fix round 1) -- this is only the final safety net for a run that never got that far (for example one
      // cancelled before ever taking a spare, whose `start()` resolves with a no-op handle and never calls attached).
    } catch (error) {
      // A rejecting transform, or a failing adapter start, must not leave the run stuck in "transpiling" forever
      // with an unhandled rejection (I3).
      if (!this.#isCurrent(run)) return;
      this.deps.runLock.remove(run.runId);
      this.#runnerError(run, error instanceof Error ? error.message : String(error));
    }
  }

  #runnerError(run: ActiveRun, message: string): void {
    this.deps.onEvents(run.tabId, run.runId, [
      {
        kind: "error",
        phase: "runner",
        name: "RuntimeError",
        message,
        stack: [],
        seq: Number.MAX_SAFE_INTEGER,
        t: Date.now(),
      },
    ]);
    this.#setState(run, "failed");
  }

  #checkHeartbeats(): void {
    const timeout = this.deps.settings().unresponsiveTimeoutMs;
    const now = Date.now();
    for (const run of this.#runs.values()) {
      if (!run.handle || (run.state !== "evaluating" && run.state !== "settled")) continue;
      if (now - run.lastHeartbeatAt > timeout) {
        // Remember what to restore on recovery (I5): the run may have gone unresponsive from "settled", not just
        // "evaluating".
        run.resumeState = run.state;
        this.#setState(run, "unresponsive");
      }
    }
  }

  #supersede(tabId: string): void {
    const previous = this.#runs.get(tabId);
    if (!previous) return;
    previous.cancelled = true;
    previous.handle?.kill();
    this.deps.runLock.remove(previous.runId);
  }

  /**
   * Fails a current run whose working directory is missing, or whose runner didn't start in it, with one
   * WorkingDirectoryError (spec §12.2). The tab's spare is discarded, so a recreated folder gets a fresh runner (M-4).
   */
  #failWorkingDirectory(run: ActiveRun, adapter: RuntimeAdapter, workingDirectory: string): void {
    if (!this.#isCurrent(run)) return;
    adapter.invalidate({ tabId: run.tabId, workingDirectory });
    this.deps.onEvents(run.tabId, run.runId, [
      {
        kind: "error",
        phase: "runner",
        name: WORKING_DIRECTORY_ERROR,
        message: strings.runs.workingDirectoryNotFound(workingDirectory),
        stack: [],
        seq: 1,
        t: Date.now(),
      },
    ]);
    this.#setState(run, "failed");
  }

  #isCurrent(run: ActiveRun): boolean {
    return !run.cancelled && this.#runs.get(run.tabId) === run;
  }

  #setState(run: ActiveRun, state: RunState, activeHandles?: number): void {
    run.state = state;
    if (activeHandles !== undefined) run.activeHandles = activeHandles;
    this.deps.onState(run.tabId, run.runId, state, activeHandles);
  }
}
