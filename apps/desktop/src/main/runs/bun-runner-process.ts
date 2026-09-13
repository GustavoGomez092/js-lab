import type { MainToRunner, RunnerToMain } from "@jslab/rpc-schema";
import type { Subprocess } from "bun";

export interface RunnerSpawnConfig {
  bunPath: string;
  bootstrapPath: string;
  cwd: string;
  env: Record<string, string>;
}

const STDERR_TAIL_BYTES = 4096;

/** Signals the runner's whole process group (it is spawned detached, as the group leader), else just the pid. */
function killProcessGroup(proc: Subprocess): void {
  try {
    process.kill(-proc.pid, "SIGKILL");
  } catch {
    proc.kill("SIGKILL");
  }
}

export class BunRunnerProcess {
  readonly #listeners = new Set<(message: RunnerToMain) => void>();
  readonly #proc: Subprocess;
  #stderrTail = "";
  lastHeartbeat = Date.now();
  bunVersion = "";
  readonly exited: Promise<number | null>;

  private constructor(proc: Subprocess) {
    this.#proc = proc;
    this.exited = proc.exited.then(() => proc.exitCode);
    // The stderr tail is best-effort diagnostics: a stream error must not become an unhandled rejection.
    this.#collectStderr(proc.stderr as ReadableStream<Uint8Array>).catch(() => {});
  }

  static start(config: RunnerSpawnConfig, timeoutMs = 5000): Promise<BunRunnerProcess> {
    return new Promise((resolve, reject) => {
      let runner: BunRunnerProcess | null = null;
      const proc = Bun.spawn([config.bunPath, "--no-env-file", config.bootstrapPath], {
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
        killProcessGroup(proc);
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

  /** SIGKILLs the runner and everything in its process group (supersede, Kill, idle expiry, stop escalation, quit). */
  kill(): void {
    killProcessGroup(this.#proc);
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
