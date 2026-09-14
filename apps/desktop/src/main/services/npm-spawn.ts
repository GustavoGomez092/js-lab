export interface NpmSpawnResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface NpmSpawnOptions {
  cwd: string;
  env: Record<string, string>;
  signal: AbortSignal;
  onOutput(text: string): void;
}

/** Runs one npm operation step: argv excludes the Bun binary. */
export type NpmSpawn = (argv: readonly string[], options: NpmSpawnOptions) => Promise<NpmSpawnResult>;

const MAX_CAPTURED_CHARS = 256 * 1024;

/**
 * Spawns the bundled Bun (spec §11.3) as its own process group, so an abort (the queue's 5-minute timeout) also stops
 * install scripts. Output streams to onOutput as it arrives; the returned text keeps the last 256 KB of each stream.
 */
export function createBunSpawn(bunPath: string): NpmSpawn {
  return async (argv, options) => {
    const proc = Bun.spawn([bunPath, ...argv], {
      cwd: options.cwd,
      env: options.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    });
    const onAbort = () => {
      try {
        process.kill(-proc.pid, "SIGKILL");
      } catch {
        proc.kill("SIGKILL");
      }
    };
    if (options.signal.aborted) onAbort();
    else options.signal.addEventListener("abort", onAbort, { once: true });
    const collect = async (stream: ReadableStream<Uint8Array>) => {
      const decoder = new TextDecoder();
      let text = "";
      for await (const chunk of stream) {
        const part = decoder.decode(chunk, { stream: true });
        options.onOutput(part);
        text = (text + part).slice(-MAX_CAPTURED_CHARS);
      }
      return text;
    };
    try {
      const [stdout, stderr, exitCode] = await Promise.all([collect(proc.stdout), collect(proc.stderr), proc.exited]);
      return { exitCode, stdout, stderr };
    } finally {
      options.signal.removeEventListener("abort", onAbort);
    }
  };
}
