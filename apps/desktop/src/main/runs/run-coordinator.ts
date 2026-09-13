import { mkdir, readdir, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import type { EncodedValue, RunEvent, RunnerToMain, RunState } from "@jslab/rpc-schema";
import type { Diagnostic, Language, TransformOptions, TransformResult } from "@jslab/transform";
import type { BunRunnerProcess } from "./bun-runner-process";
import { createEventMapper } from "./event-mapper";

export interface RunStartRequest {
  tabId: string;
  code: string;
  language: Language;
  logpoints: number[];
}

export interface RunnerSettings {
  autoLog: boolean;
  loopProtection: boolean;
  loopProtectionMaxIterations: number;
  maxEntries: number;
  unresponsiveTimeoutMs: number;
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

export class RunCoordinator {
  readonly #runs = new Map<string, ActiveRun>();
  readonly #pendingExpands = new Map<number, (value: EncodedValue | null) => void>();
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
      this.#pendingExpands.set(reqId, (value) => {
        clearTimeout(timer);
        resolve(value);
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
      const settings = this.deps.settings();
      const result = await this.deps.transform(request.code, {
        language: request.language,
        autoLog: settings.autoLog,
        loopProtection: settings.loopProtection,
        loopProtectionMaxIterations: settings.loopProtectionMaxIterations,
        logpoints: request.logpoints,
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
      void runner.exited.then((code) => this.#onRunnerExit(run, code));
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
      this.#pendingExpands.get(message.reqId)?.(message.value);
      this.#pendingExpands.delete(message.reqId);
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
        if (message.state === "idle" || message.state === "stopped") this.#scheduleIdleExpiry(run);
        else clearTimeout(run.idleTimer);
        return;
    }
  }

  #onRunnerExit(run: ActiveRun, code: number | null): void {
    clearTimeout(run.stopTimer);
    clearTimeout(run.idleTimer);
    run.unsubscribe?.();
    this.deps.runLock.remove(run.runId);
    if (run.expectedExit || !this.#isCurrent(run)) return;
    this.#runnerError(
      run,
      `Runtime exited unexpectedly (code ${code ?? "unknown"}). ${run.runner?.stderrTail ?? ""}`.trim(),
    );
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
