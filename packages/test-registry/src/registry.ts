import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { verdaccioConfig } from "./config";
import { findFreePort } from "./free-port";

export interface TestRegistry {
  url: string;
  port: number;
  pid: number;
  root: string;
  stop(): Promise<void>;
}

export interface StartTestRegistryOptions {
  root?: string;
  readyTimeoutMs?: number;
  /** Overrides the spawned command (used by tests to simulate an early exit without starting Verdaccio). */
  command?: (root: string, port: number) => string[];
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function registryCommand(root: string, port: number): string[] {
  const dir = dirname(Bun.resolveSync("verdaccio/package.json", import.meta.dir));
  const pkg = require(join(dir, "package.json")) as { bin: string | Record<string, string> };
  const bin = typeof pkg.bin === "string" ? pkg.bin : (pkg.bin.verdaccio as string);
  return [process.execPath, join(dir, bin), "--config", join(root, "config.yaml"), "--listen", `127.0.0.1:${port}`];
}

/** Thrown by `waitForReady` when the child process exits before it ever answers `-/ping`. */
class EarlyExitError extends Error {
  constructor(public readonly code: number | null) {
    super(`verdaccio exited early (code ${code})`);
  }
}

/** The last `maxChars` characters of a log file, or "" if it doesn't exist yet. */
async function tail(path: string, maxChars = 2000): Promise<string> {
  try {
    const text = await Bun.file(path).text();
    return text.length > maxChars ? text.slice(-maxChars) : text;
  } catch {
    return "";
  }
}

async function logTails(root: string): Promise<string> {
  const [out, err] = await Promise.all([tail(join(root, "registry.log")), tail(join(root, "registry.err.log"))]);
  return `--- registry.log (tail) ---\n${out}\n--- registry.err.log (tail) ---\n${err}`;
}

/**
 * Waits for `-/ping` to answer, racing every poll against the child's own exit so a crash (bad config, a lost port
 * race) is reported immediately instead of burning the whole timeout and looking like "still starting".
 */
async function waitForReady(url: string, timeoutMs: number, proc: Bun.Subprocess): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown = null;
  while (Date.now() < deadline) {
    const outcome = await Promise.race([
      fetch(`${url}-/ping`, { signal: AbortSignal.timeout(1000) })
        .then((response) => ({ kind: "ping" as const, ok: response.ok }))
        .catch((error: unknown) => ({ kind: "ping" as const, ok: false, error })),
      proc.exited.then((code) => ({ kind: "exit" as const, code })),
    ]);
    if (outcome.kind === "exit") throw new EarlyExitError(outcome.code);
    if (outcome.ok) return;
    if ("error" in outcome) last = outcome.error;
    await Bun.sleep(100);
  }
  throw new Error(`The test registry did not answer ${url}-/ping within ${timeoutMs} ms (${String(last)})`);
}

async function killIfAlive(proc: Bun.Subprocess): Promise<void> {
  if (!isAlive(proc.pid)) return;
  try {
    process.kill(proc.pid, "SIGTERM");
  } catch {}
  const exited = await Promise.race([proc.exited.then(() => true), Bun.sleep(5000).then(() => false)]);
  if (!exited && isAlive(proc.pid)) {
    try {
      process.kill(proc.pid, "SIGKILL");
    } catch {}
  }
  await proc.exited;
}

interface EarlyExit {
  code: number | null;
  tails: string;
}

/** Starts a private registry under a temp folder with a tracked PID (R-M3-PLAN-1 (e)). */
export async function startTestRegistry(options: StartTestRegistryOptions = {}): Promise<TestRegistry> {
  const root = options.root ?? (await mkdtemp(join(tmpdir(), "jslab-registry-")));
  const storage = join(root, "storage");
  const home = join(root, "home");
  await mkdir(storage, { recursive: true });
  await mkdir(home, { recursive: true });
  const command = options.command ?? registryCommand;
  const readyTimeoutMs = options.readyTimeoutMs ?? 30_000;

  const removeRoot = async () => {
    if (process.env.JSLAB_REGISTRY_KEEP !== "1") await rm(root, { recursive: true, force: true });
  };

  let firstEarlyExit: EarlyExit | null = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const port = findFreePort();
    await writeFile(join(root, "config.yaml"), verdaccioConfig({ storage, port }));
    const proc = Bun.spawn(command(root, port), {
      cwd: root,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: tmpdir(), NO_COLOR: "1" },
      stdout: Bun.file(join(root, "registry.log")),
      stderr: Bun.file(join(root, "registry.err.log")),
    });
    const url = `http://127.0.0.1:${port}/`;

    try {
      await waitForReady(url, readyTimeoutMs, proc);
    } catch (error) {
      const tails = await logTails(root);
      await killIfAlive(proc);

      if (error instanceof EarlyExitError) {
        if (attempt === 1) {
          firstEarlyExit = { code: error.code, tails };
          continue;
        }
        await removeRoot();
        throw new Error(
          "verdaccio exited early twice; no retry left.\n" +
            `attempt 1: code ${firstEarlyExit?.code}\n${firstEarlyExit?.tails}\n` +
            `attempt 2: code ${error.code}\n${tails}`,
        );
      }
      // A readiness timeout with the child still alive never retries.
      await removeRoot();
      throw new Error(`${(error as Error).message}\n${tails}`);
    }

    const stop = async () => {
      await killIfAlive(proc);
      await removeRoot();
    };
    return { url, port, pid: proc.pid, root, stop };
  }

  // Unreachable: the loop above always returns or throws.
  throw new Error("startTestRegistry: unreachable");
}
