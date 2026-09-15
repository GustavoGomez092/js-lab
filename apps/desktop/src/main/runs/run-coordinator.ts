import { mkdir, readdir, stat, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import type { EncodedValue, RunEvent, RunnerToMain, RunState } from "@jslab/rpc-schema";
import type { BuildOptions, Diagnostic, Language, TransformOptions, TransformResult } from "@jslab/transform";
import { strings } from "../strings";
import type { BunRunnerProcess } from "./bun-runner-process";
import { createEventMapper } from "./event-mapper";

export interface RunStartRequest {
  tabId: string;
  code: string;
  language: Language;
  logpoints: number[];
  /** The tab's working directory, or null (spec §5.3). */
  workingDirectory?: string | null;
  /** `__filename`'s base name (scriptFileName). */
  scriptName?: string;
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
  spares: { take(tabId: string): Promise<BunRunnerProcess>; invalidate(tabId: string): void; dispose(): void };
  runsDir: string;
  settings(): RunnerSettings;
  onEvents(tabId: string, runId: string, events: RunEvent[]): void;
  onState(tabId: string, runId: string, state: RunState, activeHandles?: number): void;
  onDiagnostics(tabId: string, runId: string, diagnostics: Diagnostic[]): void;
  runLock: { add(runId: string): void; remove(runId: string): void };
  watchdogIntervalMs?: number;
  stopGraceMs?: number;
  idleRunnerTtlMs?: number;
  expandTimeoutMs?: number;
  directoryExists?(path: string): Promise<boolean>;
}

interface ActiveRun {
  runId: string;
  tabId: string;
  state: RunState;
  runner: BunRunnerProcess | null;
  cancelled: boolean;
  expectedExit: boolean;
  stopTimer?: ReturnType<typeof setTimeout>;
  idleTimer?: ReturnType<typeof setTimeout>;
  unsubscribe?: () => void;
  // Last known activeHandles, and the state to restore when recovering from "unresponsive" (I5): the run may have
  // gone unresponsive from "settled", not just "evaluating".
  activeHandles?: number;
  resumeState?: RunState;
}

// "transpiling" is included because a runner can already be assigned (and the "run" message already sent) while
// the coordinator's own state is still "transpiling" -- the "evaluating" state event needs an IPC round trip to
// arrive. Stop must still work during that window (I1).
const STOPPABLE_STATES: ReadonlySet<RunState> = new Set(["transpiling", "evaluating", "settled", "unresponsive"]);

/** Maximum events per `run.events` message sent to the UI (spec §4.2, verified by M0-S7). */
const UI_BATCH_EVENTS = 200;

/** The error name of a run whose working directory is gone; the UI offers Change… for it (spec §12.2). */
export const WORKING_DIRECTORY_ERROR = "WorkingDirectoryError";

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export class RunCoordinator {
  readonly #runs = new Map<string, ActiveRun>();
  // Each pending expand remembers the runner it was sent to, so it can settle as soon as that runner exits.
  readonly #pendingExpands = new Map<
    number,
    { runner: BunRunnerProcess; settle: (value: EncodedValue | null) => void }
  >();
  readonly #watchdog: ReturnType<typeof setInterval>;
  #nextReqId = 1;

  constructor(private readonly deps: RunCoordinatorDeps) {
    this.#watchdog = setInterval(() => this.#checkHeartbeats(), deps.watchdogIntervalMs ?? 500);
  }

  start(request: RunStartRequest): { runId: string } {
    this.#supersede(request.tabId);
    const run: ActiveRun = {
      runId: crypto.randomUUID(),
      tabId: request.tabId,
      state: "transpiling",
      runner: null,
      cancelled: false,
      expectedExit: false,
    };
    this.#runs.set(request.tabId, run);
    this.#setState(run, "transpiling");
    void this.#execute(run, request);
    return { runId: run.runId };
  }

  stop(tabId: string): void {
    const run = this.#runs.get(tabId);
    if (!run) return;
    if (!run.runner) {
      // No runner has been taken yet: cancel outright so #execute bails out (and kills whatever runner
      // spares.take() returns later) instead of starting anything.
      if (run.state === "transpiling") {
        run.cancelled = true;
        this.#setState(run, "stopped");
      }
      return;
    }
    if (!STOPPABLE_STATES.has(run.state)) return;
    this.#setState(run, "stopping");
    run.runner.send({ type: "stop" });
    run.stopTimer = setTimeout(() => this.kill(tabId), this.deps.stopGraceMs ?? 500);
  }

  kill(tabId: string): void {
    const run = this.#runs.get(tabId);
    if (!run?.runner) return;
    clearTimeout(run.stopTimer);
    run.expectedExit = true;
    run.runner.kill();
    this.deps.runLock.remove(run.runId);
    // A stopped run is already being recycled (R-M1-18): its runner is gone either way, and it stays "stopped".
    if (run.state === "stopped") return;
    this.#setState(run, "killed");
  }

  /** The user chose "Wait" in the unresponsive dialog. */
  wait(tabId: string): void {
    const run = this.#runs.get(tabId);
    if (!run?.runner || run.state !== "unresponsive") return;
    run.runner.lastHeartbeat = Date.now();
    this.#setState(run, run.resumeState ?? "evaluating", run.activeHandles);
  }

  expand(tabId: string, runId: string, handleId: string): Promise<EncodedValue | null> {
    const run = this.#runs.get(tabId);
    if (!run?.runner || run.runId !== runId || run.state === "killed") return Promise.resolve(null);
    const reqId = this.#nextReqId++;
    const runner = run.runner;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#pendingExpands.delete(reqId);
        resolve(null);
      }, this.deps.expandTimeoutMs ?? 5000);
      this.#pendingExpands.set(reqId, {
        runner,
        settle: (value) => {
          clearTimeout(timer);
          this.#pendingExpands.delete(reqId);
          resolve(value);
        },
      });
      runner.send({ type: "expand", reqId, handleId });
    });
  }

  disposeTab(tabId: string): void {
    this.#supersede(tabId);
    this.#runs.delete(tabId);
    this.deps.spares.invalidate(tabId);
  }

  dispose(): void {
    clearInterval(this.#watchdog);
    for (const tabId of [...this.#runs.keys()]) this.disposeTab(tabId);
    this.deps.spares.dispose();
  }

  async #execute(run: ActiveRun, request: RunStartRequest): Promise<void> {
    try {
      const workingDirectory = request.workingDirectory ?? null;
      if (workingDirectory && !(await (this.deps.directoryExists ?? directoryExists)(workingDirectory))) {
        if (!this.#isCurrent(run)) return;
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
        return;
      }
      const settings = this.deps.settings();
      const result = await this.deps.transform(request.code, {
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
      });
      if (!this.#isCurrent(run)) return;
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

      const dir = join(this.deps.runsDir, run.tabId);
      await mkdir(dir, { recursive: true });
      if (!this.#isCurrent(run)) return;
      const entryPath = join(dir, `entry-${run.runId}.mjs`);
      await Bun.write(entryPath, result.code);
      if (!this.#isCurrent(run)) return;
      void this.#cleanupEntries(dir, basename(entryPath));

      let runner: BunRunnerProcess;
      try {
        runner = await this.deps.spares.take(run.tabId);
      } catch (error) {
        if (!this.#isCurrent(run)) return;
        this.#runnerError(run, `Runtime unavailable: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      if (!this.#isCurrent(run)) {
        runner.kill();
        return;
      }

      run.runner = runner;
      const mapper = createEventMapper(result.map, basename(entryPath), new Set(request.logpoints));
      run.unsubscribe = runner.onMessage((message) => this.#onRunnerMessage(run, message, mapper));
      void runner.exited.then((code) => this.#onRunnerExit(run, code, runner.signalCode));
      this.deps.runLock.add(run.runId);
      runner.lastHeartbeat = Date.now();
      // stop() may have run synchronously inside runLock.add above (I1): it already sent "stop" and armed the kill
      // timer, so sending "run" now would start user code the caller just asked to stop.
      if (run.state !== "transpiling") return;
      runner.send({ type: "run", runId: run.runId, entry: entryPath, settings: { maxEntries: settings.maxEntries } });
    } catch (error) {
      // A rejecting transform, or a failing mkdir/write/createEventMapper, must not leave the run stuck in
      // "transpiling" forever with an unhandled rejection (I3).
      if (!this.#isCurrent(run)) return;
      run.expectedExit = true;
      run.runner?.kill();
      this.deps.runLock.remove(run.runId);
      this.#runnerError(run, error instanceof Error ? error.message : String(error));
    }
  }

  #onRunnerMessage(run: ActiveRun, message: RunnerToMain, mapper: ReturnType<typeof createEventMapper>): void {
    if (message.type === "expanded") {
      this.#pendingExpands.get(message.reqId)?.settle(message.value);
      return;
    }
    if (!this.#isCurrent(run)) return;
    switch (message.type) {
      case "heartbeat":
        if (run.state === "unresponsive") this.#setState(run, run.resumeState ?? "evaluating", run.activeHandles);
        return;
      case "events": {
        // Output from code that resumed after Stop (or from a killed runner's last gasp) is never shown (I1).
        if (run.state === "stopped" || run.state === "killed") return;
        // Re-batch for the UI (spec §4.2): at most 200 events per run.events message, whatever the runner sent.
        const events = message.events.map(mapper);
        for (let i = 0; i < events.length; i += UI_BATCH_EVENTS) {
          this.deps.onEvents(run.tabId, run.runId, events.slice(i, i + UI_BATCH_EVENTS));
        }
        return;
      }
      case "state":
        if (message.state === "stopped") clearTimeout(run.stopTimer);
        if (message.state !== "evaluating") this.deps.runLock.remove(run.runId);
        if (run.state === "stopping" && message.state !== "stopped") return;
        this.#setState(run, message.state, message.activeHandles);
        if (message.state === "stopped") {
          // R-M1-18: code that resumed after Stop (a CPU loop, an awaited Bun.sleep) would keep running in this runner
          // until the idle TTL, with its output already dropped. Recycle the runner now; the next run takes a fresh
          // spare. Values from the stopped run can no longer be expanded (expand resolves null).
          clearTimeout(run.idleTimer);
          run.expectedExit = true;
          run.runner?.kill();
          return;
        }
        if (message.state === "idle") this.#scheduleIdleExpiry(run);
        else clearTimeout(run.idleTimer);
        return;
    }
  }

  #onRunnerExit(run: ActiveRun, code: number | null, signal: string | null = null): void {
    clearTimeout(run.stopTimer);
    clearTimeout(run.idleTimer);
    // A dead runner can't answer: settle its pending expands now instead of after the expand timeout.
    for (const pending of [...this.#pendingExpands.values()]) {
      if (pending.runner === run.runner) pending.settle(null);
    }
    run.unsubscribe?.();
    this.deps.runLock.remove(run.runId);
    const stderrTail = run.runner?.stderrTail ?? "";
    // The runner is gone: Kill, supersede, expand and quit must not act on it (or signal its possibly reused pid).
    run.runner = null;
    if (run.expectedExit || !this.#isCurrent(run)) return;
    if (code === 0 && signal === null) {
      // Spec §5.11 reports a crash only for a non-zero exit: a user `process.exit(0)` ends the run (final review M5).
      // A clean exit while Stop is in progress is the stop the user asked for (FA-m3).
      this.#setState(run, run.state === "stopping" ? "stopped" : "idle", 0);
      return;
    }
    const reason = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
    this.#runnerError(run, `Runtime exited unexpectedly (${reason}). ${stderrTail}`.trim());
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

  #scheduleIdleExpiry(run: ActiveRun): void {
    clearTimeout(run.idleTimer);
    run.idleTimer = setTimeout(
      () => {
        if (!run.runner) return;
        run.expectedExit = true;
        run.runner.kill();
      },
      this.deps.idleRunnerTtlMs ?? 5 * 60_000,
    );
  }

  #checkHeartbeats(): void {
    const timeout = this.deps.settings().unresponsiveTimeoutMs;
    const now = Date.now();
    for (const run of this.#runs.values()) {
      if (!run.runner || (run.state !== "evaluating" && run.state !== "settled")) continue;
      if (now - run.runner.lastHeartbeat > timeout) {
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
    previous.expectedExit = true;
    clearTimeout(previous.stopTimer);
    clearTimeout(previous.idleTimer);
    previous.unsubscribe?.();
    previous.runner?.kill();
    this.deps.runLock.remove(previous.runId);
  }

  #isCurrent(run: ActiveRun): boolean {
    return !run.cancelled && this.#runs.get(run.tabId) === run;
  }

  #setState(run: ActiveRun, state: RunState, activeHandles?: number): void {
    run.state = state;
    if (activeHandles !== undefined) run.activeHandles = activeHandles;
    this.deps.onState(run.tabId, run.runId, state, activeHandles);
  }

  async #cleanupEntries(dir: string, keep: string): Promise<void> {
    try {
      for (const name of await readdir(dir)) {
        if (name !== keep && name.startsWith("entry-")) await unlink(join(dir, name)).catch(() => {});
      }
    } catch {}
  }
}
