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

test("no output crosses IPC after the run is stopped", async () => {
  const runner = startRunner();
  await runner.run('for (let i = 0; ; i++) {\n  await Bun.sleep(20);\n  console.log("tick", i);\n}\n');
  await runner.until((m) => m.type === "events" && m.events.some((e) => e.kind === "console"));
  runner.proc.send({ type: "stop" });
  await runner.until((m) => m.type === "state" && m.state === "stopped");
  const stoppedAt = runner.messages.findIndex((m) => m.type === "state" && m.state === "stopped");
  await Bun.sleep(300);
  const after = runner.messages.slice(stoppedAt + 1).filter((m) => m.type === "events");
  expect(after).toEqual([]);
});

test("handles created after stop are disposed", async () => {
  const runner = startRunner();
  const marks = join(dir, "marks.txt");
  await runner.run(
    `import { appendFileSync } from "node:fs";\nawait Bun.sleep(150);\nsetInterval(() => appendFileSync(${JSON.stringify(marks)}, "x"), 10);\n`,
  );
  await runner.until((m) => m.type === "state" && m.state === "evaluating");
  runner.proc.send({ type: "stop" });
  await runner.until((m) => m.type === "state" && m.state === "stopped");
  await Bun.sleep(300); // the continuation resumes after stop and creates the interval
  const size = async () => ((await Bun.file(marks).exists()) ? Bun.file(marks).size : 0);
  const before = await size();
  await Bun.sleep(150);
  expect(await size()).toBe(before);
});

test("console arguments share one per-event size budget", async () => {
  const runner = startRunner();
  await runner.run('const a = Array.from({ length: 600 }, () => "z".repeat(240));\nconsole.log(a, a);\nexport {};\n');
  await runner.until((m) => m.type === "state" && m.state === "idle");
  const event = runner.events().find((e) => e.kind === "console");
  expect(event).toMatchObject({ args: [{ t: "array" }, { t: "handle", preview: "Array(600)" }] });
  expect(Buffer.byteLength(JSON.stringify(event))).toBeLessThanOrEqual(256 * 1024 + 1024);
});

test("console.log never throws into user code when an argument exhausts the size budget", async () => {
  const runner = startRunner();
  // The first argument fits but leaves less than one node's worth of budget for the second one.
  await runner.run(
    'const arr = Array.from({ length: 1000 }, (_, i) => "y".repeat(i === 999 ? 274 : 214));\nconsole.log(arr, 1);\n__jl.log(3, "after");\nexport {};\n',
  );
  await runner.until((m) => m.type === "state" && m.state === "idle");
  const events = runner.events();
  expect(events.filter((e) => e.kind === "error")).toEqual([]);
  expect(events.find((e) => e.kind === "console")).toMatchObject({
    args: [expect.anything(), { t: "number", v: "1" }],
  });
  expect(events.find((e) => e.kind === "result")).toMatchObject({ line: 3, value: { t: "string", v: "after" } });
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

// Task 18 (R-M2-T18-2): a ReferenceError for a 6 MB identifier carried the whole identifier in its message, and
// rendering that one output row froze the UI past the watchdog deadline. Error text is capped where it is created;
// Task 19 measures the caps in exact JSON bytes (R-M1-17(a)).
test("an error's name and message are capped in bytes and marked as cut", async () => {
  const runner = startRunner();
  // The name is over its 1 KB cap too, with an emoji straddling the cut: no half surrogate pair may remain (m-2).
  await runner.run(
    'const e = new Error("m".repeat(1_000_000));\ne.name = "N".repeat(1_020) + "\\u{1F600}" + "N".repeat(20_000);\nthrow e;\n',
  );
  await runner.until((m) => m.type === "state" && m.state === "idle");
  const error = runner.events().find((e) => e.kind === "error");
  const message = error?.kind === "error" ? error.message : "";
  expect(Buffer.byteLength(message)).toBeLessThanOrEqual(16 * 1024);
  expect([message.startsWith("mmm"), message.endsWith("…")]).toEqual([true, true]);
  const name = error?.kind === "error" ? error.name : "";
  expect(Buffer.byteLength(name)).toBeLessThanOrEqual(1024);
  expect([name.endsWith("N…"), /[\uD800-\uDFFF]/.test(name)]).toEqual([true, false]);
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

test("an error's message and stack stay bounded outside the value budget (R-M1-17(a))", async () => {
  const runner = startRunner();
  // One huge stdout/stderr chunk is bounded the same way: no single event, or run.events message, is megabytes.
  await runner.run(
    'process.stdout.write("s".repeat(1_000_000));\nprocess.stderr.write("€".repeat(1_000_000));\nthrow new Error("m".repeat(1_000_000));\n',
  );
  await runner.until((m) => m.type === "state" && m.state === "idle");
  const error = runner.events().find((e) => e.kind === "error") as { message: string; value: unknown } | undefined;
  expect(error?.value).toMatchObject({ t: "handle" });
  expect(Buffer.byteLength(error?.message ?? "")).toBeLessThanOrEqual(16 * 1024);
  expect(Buffer.byteLength(JSON.stringify(error))).toBeLessThanOrEqual(256 * 1024);
  const stdio = runner.events().filter((e) => e.kind === "stdout" || e.kind === "stderr");
  expect(stdio.map((e) => e.kind)).toEqual(["stdout", "stderr"]);
  for (const event of stdio) expect(Buffer.byteLength(JSON.stringify(event))).toBeLessThanOrEqual(256 * 1024);
  const messages = runner.messages.filter((m) => m.type === "events");
  for (const message of messages)
    expect(Buffer.byteLength(JSON.stringify(message))).toBeLessThanOrEqual(2 * 256 * 1024);
});

test("events pushed right before process.exit still reach Main (final review M5)", async () => {
  const runner = startRunner();
  await runner.run('console.log("last words");\nprocess.exit(0);\n');
  await runner.proc.exited;
  expect(runner.events().find((e) => e.kind === "console")).toMatchObject({
    level: "log",
    args: [{ t: "string", v: "last words" }],
  });
});
