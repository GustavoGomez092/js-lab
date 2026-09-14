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

async function waitForPing(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}-/ping`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch (error) {
      last = error;
    }
    await Bun.sleep(100);
  }
  throw new Error(`The test registry did not answer ${url}-/ping within ${timeoutMs} ms (${String(last)})`);
}

/** Starts a private registry under a temp folder with a tracked PID (R-M3-PLAN-1 (e)). */
export async function startTestRegistry(
  options: { root?: string; readyTimeoutMs?: number } = {},
): Promise<TestRegistry> {
  const root = options.root ?? (await mkdtemp(join(tmpdir(), "jslab-registry-")));
  const storage = join(root, "storage");
  const home = join(root, "home");
  await mkdir(storage, { recursive: true });
  await mkdir(home, { recursive: true });
  const port = findFreePort();
  await writeFile(join(root, "config.yaml"), verdaccioConfig({ storage, port }));
  const proc = Bun.spawn(registryCommand(root, port), {
    cwd: root,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: tmpdir(), NO_COLOR: "1" },
    stdout: Bun.file(join(root, "registry.log")),
    stderr: Bun.file(join(root, "registry.err.log")),
  });
  const url = `http://127.0.0.1:${port}/`;
  const stop = async () => {
    if (isAlive(proc.pid)) {
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
    if (process.env.JSLAB_REGISTRY_KEEP !== "1") await rm(root, { recursive: true, force: true });
  };
  try {
    await waitForPing(url, options.readyTimeoutMs ?? 30_000);
  } catch (error) {
    await stop();
    throw error;
  }
  return { url, port, pid: proc.pid, root, stop };
}
