import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunnerToMain } from "@jslab/rpc-schema";
import { BunRunnerProcess } from "../../src/main/runs/bun-runner-process";

const BOOTSTRAP = Bun.resolveSync("@jslab/runner-bun/bootstrap", import.meta.dir);

let dir = "";
const runners: BunRunnerProcess[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jslab-runner-process-"));
});
afterEach(async () => {
  for (const runner of runners.splice(0)) runner.kill();
  await rm(dir, { recursive: true, force: true });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function pgid(pid: number): number {
  return Number(
    spawnSync("ps", ["-o", "pgid=", "-p", String(pid)])
      .stdout.toString()
      .trim(),
  );
}

async function startRunner(): Promise<BunRunnerProcess> {
  const runner = await BunRunnerProcess.start({
    bunPath: process.execPath,
    bootstrapPath: BOOTSTRAP,
    cwd: dir,
    env: { PATH: process.env.PATH ?? "", JSLAB_HEARTBEAT_MS: "50" },
  });
  runners.push(runner);
  return runner;
}

test.skipIf(process.platform === "win32")("the runner leads its own process group", async () => {
  const runner = await startRunner();
  expect(pgid(runner.pid)).toBe(runner.pid);
});

test.skipIf(process.platform === "win32")(
  "killing the runner also kills processes spawned by user code",
  async () => {
    const runner = await startRunner();
    const messages: RunnerToMain[] = [];
    runner.onMessage((message) => messages.push(message));
    // Production layout (<dataDir>/runs/<tabId>/entry-<runId>.mjs, cwd = dataDir): Bun 1.4.0 can't import a file
    // created in its own cwd after it started, but it does import one in a subdirectory.
    const entry = join(dir, "runs", "t1", "entry-grandchild.mjs");
    await Bun.write(
      entry,
      'import { spawn } from "node:child_process";\nconst child = spawn("sleep", ["30"], { stdio: "ignore" });\nconsole.log(String(child.pid));\n',
    );
    runner.send({ type: "run", runId: "run-1", entry, settings: { maxEntries: 100 } });

    let childPid = 0;
    try {
      const started = Date.now();
      while (!childPid) {
        if (Date.now() - started > 5000) throw new Error(`no child pid; received ${JSON.stringify(messages)}`);
        const event = messages.flatMap((m) => (m.type === "events" ? m.events : [])).find((e) => e.kind === "console");
        if (event?.kind === "console" && event.args[0]?.t === "string") childPid = Number(event.args[0].v);
        await Bun.sleep(10);
      }
      expect(alive(childPid)).toBe(true);

      runner.kill();
      await runner.exited;

      const pollStart = Date.now();
      while (alive(childPid) && Date.now() - pollStart < 3000) await Bun.sleep(20);
      expect(alive(childPid)).toBe(false);
    } finally {
      if (childPid > 0 && alive(childPid)) process.kill(childPid, "SIGKILL");
    }
  },
  15_000,
);
