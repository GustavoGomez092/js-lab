import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RawRunEvent, RunnerToMain } from "@jslab/rpc-schema";
import type { Subprocess } from "bun";

const BOOTSTRAP = join(import.meta.dir, "../src/bootstrap.ts");

let dir = "";
const procs: Subprocess[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jslab-bootstrap-"));
});
afterEach(async () => {
  for (const proc of procs.splice(0)) proc.kill("SIGKILL");
  await rm(dir, { recursive: true, force: true });
});

function startRunner() {
  const messages: RunnerToMain[] = [];
  const proc = Bun.spawn([process.execPath, "--no-env-file", BOOTSTRAP], {
    cwd: dir,
    env: { PATH: process.env.PATH ?? "", JSLAB_HEARTBEAT_MS: "50" },
    stdout: "ignore",
    stderr: "inherit",
    ipc: (message) => messages.push(message as RunnerToMain),
    // Same wire format as production (Task 9), so values that don't survive JSON fail here.
    serialization: "json",
  });
  procs.push(proc);
  const until = async (predicate: (message: RunnerToMain) => boolean, timeoutMs = 5000) => {
    const started = Date.now();
    while (!messages.some(predicate)) {
      if (Date.now() - started > timeoutMs) throw new Error(`timed out; received ${JSON.stringify(messages)}`);
      await Bun.sleep(10);
    }
  };
  const events = (): RawRunEvent[] => messages.flatMap((m) => (m.type === "events" ? m.events : []));
  const run = async (source: string) => {
    const entry = join(dir, `entry-${crypto.randomUUID()}.mjs`);
    await Bun.write(entry, source);
    await until((m) => m.type === "ready");
    proc.send({ type: "run", runId: "run-1", entry, settings: { maxEntries: 100 } });
  };
  return { proc, messages, until, events, run };
}

test("reports ready with its Bun version and sends heartbeats", async () => {
  const runner = startRunner();
  await runner.until((m) => m.type === "heartbeat");
  expect(runner.messages.find((m) => m.type === "ready")).toMatchObject({ bunVersion: Bun.version });
});

test("runs an entry module and streams console output, results and state", async () => {
  const runner = startRunner();
  await runner.run('console.log("hi", 1);\n__jl.log(2, 40 + 2);\nexport {};\n');
  await runner.until((m) => m.type === "state" && m.state === "idle");
  const events = runner.events();
  expect(events.find((e) => e.kind === "console")).toMatchObject({
    level: "log",
    at: { line: 1 },
    args: [
      { t: "string", v: "hi" },
      { t: "number", v: "1" },
    ],
  });
  expect(events.find((e) => e.kind === "result")).toMatchObject({ line: 2, value: { t: "number", v: "42" } });
});

test("stop disposes active handles", async () => {
  const runner = startRunner();
  await runner.run("setInterval(() => {}, 10);\n");
  await runner.until((m) => m.type === "state" && m.state === "settled");
  runner.proc.send({ type: "stop" });
  await runner.until((m) => m.type === "state" && m.state === "stopped");
  expect(runner.messages.findLast((m) => m.type === "state")).toMatchObject({ state: "stopped", activeHandles: 0 });
});

test("answers expand requests for deep values", async () => {
  const runner = startRunner();
  await runner.run("__jl.log(1, { a: { b: { c: { d: 1 } } } });\n");
  await runner.until((m) => m.type === "state" && m.state === "idle");
  const handle = /"t":"handle","handle":"(h\d+)"/.exec(JSON.stringify(runner.events()))?.[1];
  expect(handle).toBeDefined();
  runner.proc.send({ type: "expand", reqId: 7, handleId: handle ?? "" });
  await runner.until((m) => m.type === "expanded");
  expect(runner.messages.find((m) => m.type === "expanded")).toMatchObject({
    reqId: 7,
    value: { t: "object", props: [[{ k: "d" }, { t: "number", v: "1" }]] },
  });
});

test("reports errors thrown while evaluating the module", async () => {
  const runner = startRunner();
  await runner.run('throw new TypeError("boom");\n');
  await runner.until((m) => m.type === "state" && m.state === "idle");
  expect(runner.events().find((e) => e.kind === "error")).toMatchObject({
    phase: "runtime",
    name: "TypeError",
    message: "boom",
  });
});

test("stop does not report errors from work it aborted", async () => {
  let requests = 0;
  const server = Bun.serve({
    port: 0,
    fetch: (_req) => {
      requests++;
      return new Promise(() => {});
    },
  });
  try {
    const port = server.port;
    const runner = startRunner();
    const source = `fetch("http://127.0.0.1:${port}/a").then(() => {});\nawait fetch("http://127.0.0.1:${port}/b");\nexport {};\n`;
    await runner.run(source);
    // Wait until the server has received 2 requests
    const started = Date.now();
    while (requests < 2) {
      if (Date.now() - started > 5000) throw new Error(`timed out; requests=${requests}`);
      await Bun.sleep(10);
    }
    runner.proc.send({ type: "stop" });
    await runner.until((m) => m.type === "state" && m.state === "stopped");
    await Bun.sleep(100);
    expect(runner.events().filter((e) => e.kind === "error")).toEqual([]);
  } finally {
    server.stop(true);
  }
});

test("the runner exits when its parent dies", async () => {
  const bootstrapPath = JSON.stringify(BOOTSTRAP);
  const dirPath = JSON.stringify(dir);
  const parentScript = `const child = Bun.spawn([process.execPath, "--no-env-file", ${bootstrapPath}], { cwd: ${dirPath}, env: { PATH: process.env.PATH ?? "" }, stdout: "ignore", stderr: "ignore", serialization: "json", ipc(message) { if (message?.type === "ready") console.log(\`RUNNER \${child.pid}\`); } }); setInterval(() => {}, 1000);`;
  const parentPath = join(dir, "parent.ts");
  await Bun.write(parentPath, parentScript);

  let runnerPid: number | null = null;
  let exited = false;

  const parent = Bun.spawn([process.execPath, "--no-env-file", parentPath], {
    stdout: "pipe",
    stderr: "inherit",
  });
  procs.push(parent);

  try {
    // Read stdout until we get the runner PID
    const reader = parent.stdout.getReader();
    let data = "";
    const started = Date.now();
    while (!runnerPid) {
      if (Date.now() - started > 5000) throw new Error("timed out waiting for RUNNER pid");
      const { done, value } = await reader.read();
      if (done) break;
      data += new TextDecoder().decode(value);
      const match = /RUNNER (\d+)/.exec(data);
      if (match) {
        runnerPid = Number(match[1]);
      }
    }
    reader.releaseLock();

    if (!runnerPid) throw new Error("never got runner pid");

    // Kill the parent
    parent.kill("SIGKILL");

    // Poll to see if the runner exits
    const pollStart = Date.now();
    while (Date.now() - pollStart < 3000) {
      try {
        process.kill(runnerPid, 0); // signal 0 checks if process exists
      } catch {
        exited = true;
        break;
      }
      await Bun.sleep(20);
    }
  } finally {
    // Clean up any leftover runner
    if (!exited && runnerPid) {
      try {
        process.kill(runnerPid, "SIGKILL");
      } catch {
        // Already dead
      }
    }
  }

  expect(exited).toBe(true);
});
