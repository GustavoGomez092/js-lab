import type { MainToRunner, RunnerToMain } from "@jslab/rpc-schema";
import type { Subprocess } from "bun";

export interface RunnerSpawnConfig {
  bunPath: string;
  bootstrapPath: string;
  cwd: string;
  env: Record<string, string>;
}

const STDERR_TAIL_BYTES = 4096;

/**
 * Signals the runner's whole process group (it is spawned detached, as the group leader), else just the pid. Once the
 * runner has exited its pid, and so its group id, may belong to an unrelated process, so nothing is signalled then.
 */
function killProcessGroup(proc: Subprocess): boolean {
  if (proc.exitCode !== null || proc.signalCode !== null) return false;
  try {
    process.kill(-proc.pid, "SIGKILL");
  } catch {
    proc.kill("SIGKILL");
  }
  return true;
}

/**
 * Kills what is left of the process group of a runner that exited on its own (user `process.exit`, a crash), so
 * processes its user code spawned don't outlive it (R-M1-17(c), R-M1-18 N3). It runs in the same callback that
 * observes the exit: while any group member lives, the group id can't be reused, and with none left the call fails
 * with ESRCH, which is ignored. If Main itself crashes, nothing signals the group (see the M2 backlog notes).
 */
function signalExitedGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {}
}

export class BunRunnerProcess {
  readonly #listeners = new Set<(message: RunnerToMain) => void>();
  readonly #proc: Subprocess;
  #stderrTail = "";
  #hasExited = false;
  #killed = false;
  lastHeartbeat = Date.now();
  bunVersion = "";
  readonly exited: Promise<number | null>;

  private constructor(proc: Subprocess) {
    this.#proc = proc;
    // Set in the same callback that resolves `exited`, so anything awaiting `exited` already sees it.
    this.exited = proc.exited.then(() => {
      if (!this.#killed) signalExitedGroup(proc.pid);
      this.#hasExited = true;
      return proc.exitCode;
    });
    // The stderr tail is best-effort diagnostics: a stream error must not become an unhandled rejection.
    this.#collectStderr(proc.stderr as ReadableStream<Uint8Array>).catch(() => {});
  }

  static start(config: RunnerSpawnConfig, timeoutMs = 5000): Promise<BunRunnerProcess> {
    return new Promise((resolve, reject) => {
      let runner: BunRunnerProcess | null = null;
      // R-M3-T14-BUNFIG-1: an empty config, so a working directory's bunfig.toml (e.g. a preload) never applies.
      const proc = Bun.spawn([config.bunPath, "--no-env-file", "--config=/dev/null", config.bootstrapPath], {
        cwd: config.cwd,
        env: config.env,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
        ipc: (message) => {
          if (runner) runner.#dispatch(message as RunnerToMain);
        },
        // M0-S3: the default "advanced" IPC serializer breaks across Bun versions. Values survive JSON because the
        // serializer sends NaN, ±Infinity, -0 and bigints as strings, typed-array items included (Task 4).
        serialization: "json",
        // setsid(): the runner leads its own process group, so killing the group also kills any process user code
        // spawned (I3). IPC and exit-on-disconnect still work (verified on Bun 1.3.13 and the bundled 1.4.0).
        detached: true,
      });
      runner = new BunRunnerProcess(proc);
      const started = runner;
      const timer = setTimeout(() => {
        started.kill();
        reject(new Error(`Runner did not start within ${timeoutMs}ms`));
      }, timeoutMs);
      const off = started.onMessage((message) => {
        if (message.type !== "ready") return;
        clearTimeout(timer);
        off();
        started.bunVersion = message.bunVersion;
        resolve(started);
      });
      void started.exited.then((code) => {
        clearTimeout(timer);
        reject(new Error(`Runner exited during startup (code ${code}). ${started.stderrTail}`.trim()));
      });
    });
  }

  get pid(): number {
    return this.#proc.pid;
  }

  get stderrTail(): string {
    return this.#stderrTail;
  }

  /** The signal that ended the process (for example "SIGKILL"), or null while it runs or after a normal exit. */
  get signalCode(): string | null {
    return this.#proc.signalCode ?? null;
  }

  onMessage(listener: (message: RunnerToMain) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  send(message: MainToRunner): void {
    try {
      this.#proc.send(message);
    } catch {
      // The process already exited; exit handling reports it.
    }
  }

  /**
   * SIGKILLs the runner and everything in its process group (supersede, Kill, idle expiry, stop escalation, quit).
   * A no-op once the runner has exited.
   */
  kill(): void {
    if (this.#hasExited) return;
    // FA-m2: only a kill that signalled counts. A kill landing after the process exited but before the exit callback
    // ran sends nothing, so the callback must still signal the leftover group.
    if (killProcessGroup(this.#proc)) this.#killed = true;
  }

  #dispatch(message: RunnerToMain): void {
    if (message.type === "heartbeat") this.lastHeartbeat = Date.now();
    for (const listener of this.#listeners) listener(message);
  }

  async #collectStderr(stream: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      this.#stderrTail = (this.#stderrTail + decoder.decode(chunk, { stream: true })).slice(-STDERR_TAIL_BYTES);
    }
  }
}
