import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunEvent, RunState } from "@jslab/rpc-schema";
import { transform } from "@jslab/transform";
import { BunRunnerProcess } from "../../src/main/runs/bun-runner-process";
import { RunCoordinator } from "../../src/main/runs/run-coordinator";
import { SparePool } from "../../src/main/runs/spare-pool";

const FIXTURE = join(import.meta.dir, "fixtures", "exit-requested-hang-runner.ts");
let dir = "";
let coordinator: RunCoordinator | null = null;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jslab-exit-"));
});
afterEach(async () => {
  coordinator?.dispose();
  coordinator = null;
  await rm(dir, { recursive: true, force: true });
});

test("a runner that requested exit but hangs is killed after the grace period and ends as its requested code (FW1)", async () => {
  const events: RunEvent[] = [];
  const states: RunState[] = [];
  // Every runner the pool starts: the first runs the code, and the pool pre-warms another one after the take.
  const runners: BunRunnerProcess[] = [];
  coordinator = new RunCoordinator({
    transform: async (source, options) => transform(source, options),
    spares: new SparePool(
      async (config) => {
        const runner = await BunRunnerProcess.start(config);
        runners.push(runner);
        return runner;
      },
      () => ({ bunPath: process.execPath, bootstrapPath: FIXTURE, cwd: dir, env: { PATH: process.env.PATH ?? "" } }),
    ),
    runsDir: join(dir, "runs"),
    settings: () => ({
      autoLog: true,
      loopProtection: true,
      loopProtectionMaxIterations: 2000,
      maxEntries: 100,
      unresponsiveTimeoutMs: 5000,
    }),
    onEvents: (_tabId, _runId, batch) => events.push(...batch),
    onState: (_tabId, _runId, state) => states.push(state),
    onDiagnostics: () => {},
    runLock: { add: () => {}, remove: () => {} },
    exitGraceMs: 150,
  });
  coordinator.start({ tabId: "t1", code: "1", language: "typescript", logpoints: [] });
  const started = Date.now();
  while (!states.includes("idle") && Date.now() - started < 5000) await Bun.sleep(20);
  expect(states).toContain("idle");
  expect(events.filter((event) => event.kind === "error" || event.kind === "stdout")).toEqual([]);
  expect(runners[0]?.signalCode).toBe("SIGKILL");
}, 15000);
