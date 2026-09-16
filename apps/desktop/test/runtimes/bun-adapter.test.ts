import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EncodedValue, MainToRunner, RawRunEvent, RunEvent, RunnerToMain, RunState } from "@jslab/rpc-schema";
import type { BunRunnerProcess } from "../../src/main/runs/bun-runner-process";
import type { PreparedRun, RunEventSink, RunHandle } from "../../src/main/runtimes/adapter";
import { type BunAdapterDeps, createBunAdapter, type SpareSource } from "../../src/main/runtimes/bun-adapter";

/** A `BunRunnerProcess`-shaped fake fully controlled by the test: no real process is ever spawned. */
class FakeRunner {
  readonly #listeners = new Set<(message: RunnerToMain) => void>();
  #exitResolve!: (code: number | null) => void;
  readonly exited: Promise<number | null>;
  readonly sent: MainToRunner[] = [];
  signalCode: string | null = null;
  stderrTail = "";
  killed = false;

  constructor(readonly cwd: string) {
    this.exited = new Promise((resolve) => {
      this.#exitResolve = resolve;
    });
  }

  onMessage(listener: (message: RunnerToMain) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  send(message: MainToRunner): void {
    this.sent.push(message);
  }

  kill(): void {
    if (this.killed) return;
    this.killed = true;
    this.signalCode = "SIGKILL";
    this.#exitResolve(null);
  }

  /** Simulates a message arriving from the runner over IPC. */
  emit(message: RunnerToMain): void {
    for (const listener of [...this.#listeners]) listener(message);
  }

  /** Simulates the OS process exiting on its own (a crash, or a clean `process.exit`). */
  exit(code: number | null): void {
    this.#exitResolve(code);
  }
}

interface Harness {
  runner: FakeRunner;
  handle: RunHandle;
  events: RunEvent[];
  states: { state: RunState; activeHandles?: number }[];
  exitedCalls: () => number;
  locks: Set<string>;
  prepared: string[];
  invalidated: string[];
  dir: string;
}

const identityMap = (event: RawRunEvent): RunEvent => event as RunEvent;

async function createHarness(
  overrides: Partial<Omit<BunAdapterDeps, "spares" | "runLock" | "runsDir">> = {},
): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "jslab-bun-adapter-"));
  const runner = new FakeRunner(dir);
  const locks = new Set<string>();
  const prepared: string[] = [];
  const invalidated: string[] = [];
  const spares: SpareSource = {
    take: () => Promise.resolve(runner as unknown as BunRunnerProcess),
    prepare: (tabId) => prepared.push(tabId),
    invalidate: (tabId) => invalidated.push(tabId),
  };
  const adapter = createBunAdapter({
    spares,
    runsDir: dir,
    runLock: { add: (id) => locks.add(id), remove: (id) => locks.delete(id) },
    exitGraceMs: 2500,
    ...overrides,
  });
  const events: RunEvent[] = [];
  const states: Harness["states"] = [];
  let exitedCalls = 0;
  const sink: RunEventSink = {
    events: (batch) => events.push(...batch),
    state: (state, activeHandles) => states.push({ state, activeHandles }),
    heartbeat: () => {},
    exited: () => {
      exitedCalls++;
    },
  };
  const run: PreparedRun = {
    runId: "run-1",
    tabId: "t1",
    code: "1 + 1",
    maxEntries: 10_000,
    workingDirectory: dir,
    mapEvent: identityMap,
    isCancelled: () => false,
  };
  const handle = await adapter.start(run, sink);
  return { runner, handle, events, states, exitedCalls: () => exitedCalls, locks, prepared, invalidated, dir };
}

describe("BunAdapter", () => {
  test("start() takes a spare, writes the entry file, and sends run", async () => {
    const h = await createHarness();
    try {
      expect(h.runner.sent).toEqual([
        { type: "run", runId: "run-1", entry: join(h.dir, "t1", "entry-run-1.mjs"), settings: { maxEntries: 10_000 } },
      ]);
      expect(await readFile(join(h.dir, "t1", "entry-run-1.mjs"), "utf8")).toBe("1 + 1");
      expect(h.locks.has("run-1")).toBe(true);
    } finally {
      await rm(h.dir, { recursive: true, force: true });
    }
  });

  test("stop() escalates to kill after the grace period when the runner never acknowledges", async () => {
    const h = await createHarness({ stopGraceMs: 30 });
    try {
      void h.handle.stop();
      expect(h.runner.sent.at(-1)).toEqual({ type: "stop" });
      expect(h.runner.killed).toBe(false);
      await Bun.sleep(80);
      expect(h.runner.killed).toBe(true);
      expect(h.states.at(-1)).toEqual({ state: "killed", activeHandles: undefined });
      expect(h.locks.has("run-1")).toBe(false);
    } finally {
      await rm(h.dir, { recursive: true, force: true });
    }
  });

  test("stop() does not escalate once the runner acknowledges stopped", async () => {
    const h = await createHarness({ stopGraceMs: 30 });
    try {
      void h.handle.stop();
      h.runner.emit({ type: "state", runId: "run-1", state: "stopped", activeHandles: 0 });
      // The runner is then killed right away (this task's R-M1-18 recycle: a stopped runner is recycled immediately).
      expect(h.runner.killed).toBe(true);
      await Bun.sleep(80); // past the 30ms grace period: no escalation should still fire.
      expect(h.states.filter((s) => s.state === "killed")).toEqual([]);
      expect(h.states.at(-1)).toEqual({ state: "stopped", activeHandles: 0 });
    } finally {
      await rm(h.dir, { recursive: true, force: true });
    }
  });

  test("expand() resolves the runner's reply, and resolves null once the runner exits with one pending", async () => {
    const h = await createHarness();
    try {
      const value: EncodedValue = { t: "number", v: "42" };
      const pending = h.handle.expand("h1");
      expect(h.runner.sent.at(-1)).toEqual({ type: "expand", reqId: 1, handleId: "h1" });
      h.runner.emit({ type: "expanded", reqId: 1, value });
      expect(await pending).toEqual(value);

      const pendingOnExit = h.handle.expand("h2");
      h.runner.exit(0);
      expect(await pendingOnExit).toBeNull();
      expect(h.exitedCalls()).toBe(1);
    } finally {
      await rm(h.dir, { recursive: true, force: true });
    }
  });
});
