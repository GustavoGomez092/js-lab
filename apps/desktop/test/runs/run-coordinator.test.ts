import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunEvent, RunState } from "@jslab/rpc-schema";
import { transform } from "@jslab/transform";
import { BunRunnerProcess } from "../../src/main/runs/bun-runner-process";
import { RunCoordinator, type RunnerSettings } from "../../src/main/runs/run-coordinator";
import { SparePool } from "../../src/main/runs/spare-pool";

const BOOTSTRAP = Bun.resolveSync("@jslab/runner-bun/bootstrap", import.meta.dir);

interface Harness {
  coordinator: RunCoordinator;
  events: RunEvent[];
  states: { runId: string; state: RunState; activeHandles?: number }[];
  locks: Set<string>;
  settings: RunnerSettings;
  waitForState(state: RunState, runId?: string, timeoutMs?: number): Promise<void>;
  dir: string;
}

const harnesses: Harness[] = [];

async function createHarness(overrides: Partial<RunnerSettings> = {}): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "jslab-coord-"));
  const settings: RunnerSettings = {
    autoLog: true,
    loopProtection: true,
    loopProtectionMaxIterations: 2000,
    maxEntries: 10_000,
    unresponsiveTimeoutMs: 400,
    ...overrides,
  };
  const events: RunEvent[] = [];
  const states: Harness["states"] = [];
  const locks = new Set<string>();
  const spares = new SparePool(
    (config) => BunRunnerProcess.start(config),
    () => ({
      bunPath: process.execPath,
      bootstrapPath: BOOTSTRAP,
      cwd: dir,
      env: { PATH: process.env.PATH ?? "", JSLAB_HEARTBEAT_MS: "50" },
    }),
  );
  const coordinator = new RunCoordinator({
    transform: async (source, options) => transform(source, options),
    spares,
    runsDir: join(dir, "runs"),
    settings: () => settings,
    onEvents: (_tab, _run, batch) => events.push(...batch),
    onState: (_tab, runId, state, activeHandles) => states.push({ runId, state, activeHandles }),
    onDiagnostics: () => {},
    runLock: { add: (id) => locks.add(id), remove: (id) => locks.delete(id) },
    watchdogIntervalMs: 50,
    stopGraceMs: 300,
  });
  const waitForState = async (state: RunState, runId?: string, timeoutMs = 8000) => {
    const started = Date.now();
    while (!states.some((s) => s.state === state && (!runId || s.runId === runId))) {
      if (Date.now() - started > timeoutMs)
        throw new Error(`timed out waiting for ${state}; saw ${JSON.stringify(states)}`);
      await Bun.sleep(10);
    }
  };
  const harness = { coordinator, events, states, locks, settings, waitForState, dir };
  harnesses.push(harness);
  return harness;
}

afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    h.coordinator.dispose();
    await rm(h.dir, { recursive: true, force: true });
  }
});

const flush = () => Bun.sleep(60);

describe("RunCoordinator", () => {
  test("runs TypeScript and reports results and console output on original lines", async () => {
    const h = await createHarness();
    const { runId } = h.coordinator.start({
      tabId: "t1",
      code: "const a: number = 2;\nconsole.log('hi', a)\na * 21",
      language: "typescript",
      logpoints: [],
    });
    await h.waitForState("idle", runId);
    await flush();
    const console_ = h.events.find((e) => e.kind === "console");
    expect(console_).toMatchObject({
      level: "log",
      line: 2,
      args: [
        { t: "string", v: "hi" },
        { t: "number", v: "2" },
      ],
    });
    expect(h.events.find((e) => e.kind === "result")).toMatchObject({
      line: 3,
      source: "autolog",
      value: { t: "number", v: "42" },
    });
  }, 15_000);

  test("reports syntax errors without starting a runner", async () => {
    const h = await createHarness();
    const { runId } = h.coordinator.start({ tabId: "t1", code: "const x = ;", language: "typescript", logpoints: [] });
    await h.waitForState("failed", runId);
    expect(h.events[0]).toMatchObject({ kind: "error", phase: "transpile", line: 1, column: 11 });
  }, 15_000);

  test("maps runtime errors to the original line", async () => {
    const h = await createHarness();
    const { runId } = h.coordinator.start({
      tabId: "t1",
      code: "type T = { a: number };\n\nthrow new Error('boom')",
      language: "typescript",
      logpoints: [],
    });
    await h.waitForState("idle", runId);
    await flush();
    expect(h.events.find((e) => e.kind === "error")).toMatchObject({ phase: "runtime", message: "boom", line: 3 });
  }, 15_000);

  test("supersedes a running run and kills its runner", async () => {
    const h = await createHarness();
    const first = h.coordinator.start({
      tabId: "t1",
      code: "await new Promise((r) => setTimeout(r, 10_000))",
      language: "typescript",
      logpoints: [],
    });
    await h.waitForState("evaluating", first.runId);
    const second = h.coordinator.start({ tabId: "t1", code: "1 + 1", language: "typescript", logpoints: [] });
    await h.waitForState("idle", second.runId);
    expect(h.states.filter((s) => s.runId === first.runId).map((s) => s.state)).toEqual(["transpiling", "evaluating"]);
    expect(h.locks.size).toBe(0);
  }, 15_000);

  test("stops async work gracefully", async () => {
    const h = await createHarness();
    const { runId } = h.coordinator.start({
      tabId: "t1",
      code: "setInterval(() => {}, 10)",
      language: "typescript",
      logpoints: [],
    });
    await h.waitForState("settled", runId);
    expect(h.states.find((s) => s.state === "settled")?.activeHandles).toBe(1);
    h.coordinator.stop("t1");
    await h.waitForState("stopped", runId);
    expect(h.states.some((s) => s.state === "killed")).toBe(false);
  }, 15_000);

  test("detects an unresponsive run and escalates stop to kill", async () => {
    const h = await createHarness({ loopProtection: false });
    const { runId } = h.coordinator.start({
      tabId: "t1",
      code: "while (true) {}",
      language: "typescript",
      logpoints: [],
    });
    await h.waitForState("unresponsive", runId);
    h.coordinator.stop("t1");
    await h.waitForState("killed", runId);
  }, 15_000);

  test("enforces the output cap in the runner", async () => {
    const h = await createHarness({ maxEntries: 10 });
    const { runId } = h.coordinator.start({
      tabId: "t1",
      code: "for (let i = 0; i < 50; i++) console.log(i)",
      language: "typescript",
      logpoints: [],
    });
    await h.waitForState("idle", runId);
    await flush();
    expect(h.events.filter((e) => e.kind === "console")).toHaveLength(10);
    expect(h.events.filter((e) => e.kind === "truncated").at(-1)).toMatchObject({ dropped: 40 });
  }, 15_000);

  test("expands deep values while the runner is alive", async () => {
    const h = await createHarness();
    const { runId } = h.coordinator.start({
      tabId: "t1",
      code: "({ a: { b: { c: { d: 1 } } } })",
      language: "typescript",
      logpoints: [],
    });
    await h.waitForState("idle", runId);
    await flush();
    const json = JSON.stringify(h.events.find((e) => e.kind === "result"));
    const handle = /"t":"handle","handle":"(h\d+)"/.exec(json)?.[1];
    expect(handle).toBeDefined();
    expect(await h.coordinator.expand("t1", runId, handle ?? "")).toMatchObject({
      t: "object",
      props: [[{ k: "d" }, { t: "number", v: "1" }]],
    });
  }, 15_000);

  test("reports a runner that exits unexpectedly", async () => {
    const h = await createHarness();
    const { runId } = h.coordinator.start({
      tabId: "t1",
      code: "process.exit(3)",
      language: "typescript",
      logpoints: [],
    });
    await h.waitForState("failed", runId);
    expect(h.events.at(-1)).toMatchObject({ kind: "error", phase: "runner" });
    expect((h.events.at(-1) as { message: string }).message).toContain("code 3");
  }, 15_000);

  test("updates promise results when they settle", async () => {
    const h = await createHarness();
    const { runId } = h.coordinator.start({
      tabId: "t1",
      code: "new Promise((r) => setTimeout(() => r(7), 30))",
      language: "typescript",
      logpoints: [],
    });
    await h.waitForState("idle", runId);
    await Bun.sleep(150);
    expect(h.events.find((e) => e.kind === "result")).toMatchObject({ value: { t: "promise", state: "pending" } });
    expect(h.events.find((e) => e.kind === "promiseSettled")).toMatchObject({
      value: { t: "promise", state: "fulfilled", value: { t: "number", v: "7" } },
    });
  }, 15_000);

  test("surfaces unhandled rejections", async () => {
    const h = await createHarness({ autoLog: false });
    const { runId } = h.coordinator.start({
      tabId: "t1",
      code: "Promise.reject(new Error('nope'))",
      language: "typescript",
      logpoints: [],
    });
    await h.waitForState("idle", runId);
    await flush();
    expect(h.events.find((e) => e.kind === "error")).toMatchObject({ phase: "unhandledRejection", message: "nope" });
  }, 15_000);

  test("labels logpoint results and captures stdout writes", async () => {
    const h = await createHarness({ autoLog: false });
    const { runId } = h.coordinator.start({
      tabId: "t1",
      code: "const a = 5;\nprocess.stdout.write('raw\\n');",
      language: "typescript",
      logpoints: [1],
    });
    await h.waitForState("idle", runId);
    await flush();
    expect(h.events.find((e) => e.kind === "result")).toMatchObject({ source: "logpoint", line: 1, value: { v: "5" } });
    expect(h.events.find((e) => e.kind === "stdout")).toMatchObject({ text: "raw\n" });
  }, 15_000);
});
