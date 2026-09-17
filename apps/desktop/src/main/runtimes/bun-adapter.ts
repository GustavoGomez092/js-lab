import { mkdir, readdir, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import type { EncodedValue, RunnerToMain, RunState } from "@jslab/rpc-schema";
import type { BunRunnerProcess } from "../runs/bun-runner-process";
import {
  type PreparedRun,
  type RunEventSink,
  type RunHandle,
  type RuntimeAdapter,
  type TabRunContext,
  WorkingDirectoryMismatchError,
} from "./adapter";

export interface SpareSource {
  take(tabId: string): Promise<BunRunnerProcess>;
  prepare(tabId: string): void;
  invalidate(tabId: string): void;
}

export interface BunAdapterDeps {
  spares: SpareSource;
  runsDir: string;
  runLock: { add(runId: string): void; remove(runId: string): void };
  /** Stop's graceful-then-kill escalation window (spec §5.1). Defaults to 500 ms, same as before this task. */
  stopGraceMs?: number;
  /** How long a runner stays warm after its run goes idle before being killed. Defaults to 5 minutes. */
  idleRunnerTtlMs?: number;
  /** How long `expand()` waits for a reply before resolving null. Defaults to 5 s. */
  expandTimeoutMs?: number;
  /** How long Main waits after `exitRequested` before ending a runner that didn't exit on its own. */
  exitGraceMs: number;
}

function deadHandle(runId: string): RunHandle {
  return { runId, stop: () => Promise.resolve(), kill: () => {}, expand: () => Promise.resolve(null) };
}

/**
 * One Bun run in flight: owns the spawned runner's IPC conversation (the `RunnerToMain` wire protocol is entirely
 * internal to this class -- `RunCoordinator` only ever sees `RunEventSink` calls and the `RunHandle` it returns).
 */
class BunRunSession implements RunHandle {
  readonly runId: string;
  #expectedExit = false;
  #stopRequested = false;
  #terminal: "stopped" | "killed" | null = null;
  #exitRequestedCode: number | undefined;
  #stopTimer?: ReturnType<typeof setTimeout>;
  #idleTimer?: ReturnType<typeof setTimeout>;
  #exitTimer?: ReturnType<typeof setTimeout>;
  #stopSettle?: () => void;
  #unsubscribe: () => void = () => {};
  #nextReqId = 1;
  readonly #pendingExpands = new Map<number, (value: EncodedValue | null) => void>();

  constructor(
    private readonly runner: BunRunnerProcess,
    private readonly run: PreparedRun,
    private readonly sink: RunEventSink,
    private readonly deps: BunAdapterDeps,
  ) {
    this.runId = run.runId;
  }

  /** Attaches the runner's message/exit listeners; called once, right after this session is constructed. */
  wire(): void {
    this.#unsubscribe = this.runner.onMessage((message) => this.#onMessage(message));
    void this.runner.exited.then((code) => this.#onExit(code, this.runner.signalCode));
  }

  /** Whether `stop()` has already been called -- checked by `start()` before it would otherwise send "run". */
  get stopRequested(): boolean {
    return this.#stopRequested;
  }

  async stop(): Promise<void> {
    if (this.#terminal) return;
    this.#stopRequested = true;
    this.runner.send({ type: "stop" });
    return new Promise((resolve) => {
      this.#stopSettle = resolve;
      this.#stopTimer = setTimeout(() => {
        if (!this.#terminal) {
          this.#terminal = "killed";
          this.killExpected();
          this.#reportTerminal("killed");
        }
        this.#settleStop();
      }, this.deps.stopGraceMs ?? 500);
    });
  }

  /**
   * Settles a pending `stop()` and clears its escalation timer, together, so the two can never drift apart.
   *
   * `stop()` returns a promise, and every terminal path has to settle it. Previously only the `state: "stopped"`
   * message did: a runner that answered Stop by exiting cleanly instead took `#onExit`, which cleared the
   * escalation timer -- the one remaining thing that could have settled it -- and then reported the terminal state
   * without ever resolving the promise, leaving it pending for the process's life. Nothing hung in practice only
   * because the single caller ignored the promise (`void run.handle.stop()`), so the broken contract was invisible
   * to a fully passing suite; the first caller to await it would have waited forever.
   */
  #settleStop(): void {
    clearTimeout(this.#stopTimer);
    const settle = this.#stopSettle;
    this.#stopSettle = undefined;
    settle?.();
  }

  kill(): void {
    clearTimeout(this.#stopTimer);
    this.#terminal = "killed";
    this.killExpected();
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
      this.runner.send({ type: "expand", reqId, handleId });
    });
  }

  /** A quiet kill: no state is reported (the caller either already reported one itself, or never started a run). */
  killExpected(): void {
    if (this.#expectedExit) return;
    this.#expectedExit = true;
    this.runner.kill();
  }

  #onMessage(message: RunnerToMain): void {
    if (message.type === "expanded") {
      this.#pendingExpands.get(message.reqId)?.(message.value);
      this.#pendingExpands.delete(message.reqId);
      return;
    }
    switch (message.type) {
      case "exitRequested":
        this.#exitRequestedCode = message.code;
        clearTimeout(this.#exitTimer);
        // Not `killExpected`: the exit must still be interpreted normally below (using exitRequestedCode) once it
        // actually happens, rather than suppressed as an intentional kill (FW1).
        this.#exitTimer = setTimeout(() => this.runner.kill(), this.deps.exitGraceMs);
        return;
      case "heartbeat":
        this.sink.heartbeat();
        return;
      case "events": {
        // Output from code that resumed after Stop (or from a killed runner's last gasp) is never shown (I1).
        // FW1: output after a caught process.exit is dropped too (the runner's buffer is already closed).
        if (this.#terminal || this.#exitRequestedCode !== undefined) return;
        this.sink.events(message.events.map((event) => this.run.mapEvent(event)));
        return;
      }
      case "state":
        if (message.state === "stopped") this.#settleStop();
        if (message.state !== "evaluating") this.deps.runLock.remove(this.run.runId);
        if (this.#stopRequested && message.state !== "stopped") return;
        this.sink.state(message.state, message.activeHandles);
        if (message.state === "stopped") {
          // R-M1-18: code that resumed after Stop would keep running in this runner until the idle TTL, with its
          // output already dropped. Recycle now; the next run takes a fresh spare.
          this.#terminal = "stopped";
          clearTimeout(this.#idleTimer);
          this.killExpected();
          return;
        }
        if (message.state === "idle") this.#scheduleIdleExpiry();
        else clearTimeout(this.#idleTimer);
        return;
    }
  }

  #onExit(exitCode: number | null, exitSignal: string | null): void {
    // The runtime is gone, so no acknowledgement is ever coming: settle any pending stop() here rather than just
    // clearing its timer, which would strand the promise forever.
    this.#settleStop();
    clearTimeout(this.#idleTimer);
    clearTimeout(this.#exitTimer);
    for (const settle of [...this.#pendingExpands.values()]) settle(null);
    this.#pendingExpands.clear();
    this.#unsubscribe();
    this.deps.runLock.remove(this.run.runId);
    const stderrTail = this.runner.stderrTail;
    // Unconditionally, before the expectedExit check below: the runtime is gone either way, expected or not, and
    // RunCoordinator must not act on this handle again (Kill after it already exited, expand, ...).
    this.sink.exited();
    // The runner already told us this exit was requested (kill/supersede/idle-expiry/stop-escalation): nothing more
    // to report (I3).
    if (this.#expectedExit) return;
    // FW1: a runner Main ended after exitRequested reports the code user code asked for.
    const endedAfterExit = this.#exitRequestedCode !== undefined && exitSignal === "SIGKILL";
    const code = endedAfterExit ? (this.#exitRequestedCode as number) : exitCode;
    const signal = endedAfterExit ? null : exitSignal;
    if (code === 0 && signal === null) {
      // Spec §5.11 reports a crash only for a non-zero exit: a user `process.exit(0)` ends the run (final review
      // M5). A clean exit while Stop is in progress is the stop the user asked for (FA-m3).
      this.#reportTerminal(this.#stopRequested ? "stopped" : "idle", 0);
      return;
    }
    const reason = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
    this.#fail(`Runtime exited unexpectedly (${reason}). ${stderrTail}`.trim());
  }

  #fail(message: string): void {
    this.sink.events([
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
    this.#reportTerminal("failed");
  }

  #reportTerminal(state: RunState, activeHandles?: number): void {
    this.deps.runLock.remove(this.run.runId);
    this.sink.state(state, activeHandles);
  }

  #scheduleIdleExpiry(): void {
    clearTimeout(this.#idleTimer);
    this.#idleTimer = setTimeout(() => this.killExpected(), this.deps.idleRunnerTtlMs ?? 5 * 60_000);
  }
}

async function cleanupEntries(dir: string, keep: string): Promise<void> {
  try {
    for (const name of await readdir(dir)) {
      if (name !== keep && name.startsWith("entry-")) await unlink(join(dir, name)).catch(() => {});
    }
  } catch {}
}

/** The Bun `RuntimeAdapter` (spec §5.1): the only real implementation until Task 7 adds `WebAdapter`. */
export function createBunAdapter(deps: BunAdapterDeps): RuntimeAdapter {
  return {
    id: "bun",

    async prepare(tab: TabRunContext): Promise<void> {
      deps.spares.prepare(tab.tabId);
    },

    invalidate(tab: TabRunContext): void {
      deps.spares.invalidate(tab.tabId);
    },

    async dispose(tabId: string): Promise<void> {
      deps.spares.invalidate(tabId);
    },

    async start(run: PreparedRun, sink: RunEventSink): Promise<RunHandle> {
      const dir = join(deps.runsDir, run.tabId);
      await mkdir(dir, { recursive: true });
      if (run.isCancelled()) return deadHandle(run.runId);
      const entryPath = join(dir, `entry-${run.runId}.mjs`);
      await Bun.write(entryPath, run.code);
      if (run.isCancelled()) return deadHandle(run.runId);
      void cleanupEntries(dir, basename(entryPath));

      let runner: BunRunnerProcess;
      try {
        runner = await deps.spares.take(run.tabId);
      } catch (error) {
        throw new Error(`Runtime unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }

      // Fail closed (M-3): a folder deleted after the check makes the runner config fall back to the data folder,
      // and user code must never run (or write relative files) there.
      if (run.workingDirectory && typeof runner.cwd === "string" && runner.cwd !== run.workingDirectory) {
        runner.kill();
        throw new WorkingDirectoryMismatchError(run.workingDirectory);
      }
      if (run.isCancelled()) {
        runner.kill();
        return deadHandle(run.runId);
      }

      const session = new BunRunSession(runner, run, sink, deps);
      session.wire();
      // Hand the handle back the moment it's controllable, before any lock or start-message work (M4 T2 fix 1,
      // review Finding 1): a stop() arriving reentrantly from runLock.add below must find a handle to act on and
      // take the graceful branch, exactly as the pre-refactor code did by assigning `run.runner` at this same point.
      sink.attached(session);
      deps.runLock.add(run.runId);
      runner.lastHeartbeat = Date.now();
      // stop() may have run synchronously inside runLock.add above (I1), via the handle attached() just provided:
      // it already sent "stop" and armed its own escalation, so sending "run" now would race a run the caller just
      // asked to stop.
      if (session.stopRequested) return session;
      // A supersede/dispose raced ahead instead (no handle existed for it to use before attached() ran): it will
      // already have called `session.kill()` through the handle it now has, so there's nothing left to kill here.
      if (run.isCancelled()) {
        deps.runLock.remove(run.runId);
        return session;
      }
      runner.send({ type: "run", runId: run.runId, entry: entryPath, settings: { maxEntries: run.maxEntries } });
      return session;
    },
  };
}
