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
  attachedCalls: () => number;
  locks: Set<string>;
  prepared: string[];
  invalidated: string[];
  dir: string;
}

interface HarnessHooks {
  /** Called the moment `sink.attached()` fires, before `runLock.add`/the "run" message (F1, fix round 1). */
  onAttached?: (handle: RunHandle) => void;
  /** Called the moment `runLock.add` fires -- the exact reentrancy pinch point `run-coordinator.test.ts` uses. */
  onLockAdd?: () => void;
}

const identityMap = (event: RawRunEvent): RunEvent => event as RunEvent;

async function createHarness(
  overrides: Partial<Omit<BunAdapterDeps, "spares" | "runLock" | "runsDir">> = {},
  hooks: HarnessHooks = {},
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
    runLock: {
      add: (id) => {
        locks.add(id);
        hooks.onLockAdd?.();
      },
      remove: (id) => locks.delete(id),
    },
    exitGraceMs: 2500,
    ...overrides,
  });
  const events: RunEvent[] = [];
  const states: Harness["states"] = [];
  let exitedCalls = 0;
  let attachedCalls = 0;
  const sink: RunEventSink = {
    attached: (handle) => {
      attachedCalls++;
      hooks.onAttached?.(handle);
    },
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
  return {
    runner,
    handle,
    events,
    states,
    exitedCalls: () => exitedCalls,
    attachedCalls: () => attachedCalls,
    locks,
    prepared,
    invalidated,
    dir,
  };
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

  // Task 9d: `stop()`'s promise was settled only by the `state: "stopped"` message handler. A runner that answers
  // Stop by exiting cleanly instead (exactly what test/runs/fixtures/exit-on-stop-runner.ts does) takes `#onExit`,
  // which clears `#stopTimer` -- destroying the grace-period fallback that was the only other thing that could
  // settle it -- and then reports the terminal state without ever settling the promise. Nothing hung in practice
  // only because the sole caller was `void run.handle.stop()`; this test awaits the contract, which is precisely
  // why a full passing suite never saw it.
  test("stop() settles when the runner answers by exiting cleanly rather than acknowledging", async () => {
    const h = await createHarness({ stopGraceMs: 30 });
    try {
      const settled = h.handle.stop().then(() => "settled" as const);
      expect(h.runner.sent.at(-1)).toEqual({ type: "stop" });
      h.runner.exit(0);
      // Far longer than the 30 ms grace period: if only the (now cleared) escalation timer could settle this, the
      // promise is never going to settle at all.
      const outcome = await Promise.race([settled, Bun.sleep(300).then(() => "hung" as const)]);
      expect(outcome).toBe("settled");
      // The clean exit while stopping is still reported as the stop the user asked for (FA-m3), not as idle.
      expect(h.states.at(-1)).toEqual({ state: "stopped", activeHandles: 0 });
    } finally {
      await rm(h.dir, { recursive: true, force: true });
    }
  });

  test("a stop() reentrant on runLock.add still takes the graceful branch, not a bare cancel (F1, fix round 1)", async () => {
    let handle: RunHandle | undefined;
    const h = await createHarness(
      { stopGraceMs: 300 },
      {
        onAttached: (attached) => {
          handle = attached;
        },
        // The exact pinch point run-coordinator.test.ts's own "stop right after the runner is assigned" test uses:
        // a stop() call reentrant from inside runLock.add, before the "run" message would otherwise be sent.
        onLockAdd: () => {
          void handle?.stop();
        },
      },
    );
    try {
      expect(h.attachedCalls()).toBe(1);
      // The graceful branch: "stop" was sent and "run" never was -- not a bare cancel with nothing sent at all.
      expect(h.runner.sent).toEqual([{ type: "stop" }]);
      expect(h.runner.killed).toBe(false);
      await Bun.sleep(50);
      expect(h.locks.has("run-1")).toBe(true); // the graceful stop's escalation timer is still pending
      await Bun.sleep(300);
      expect(h.runner.killed).toBe(true); // escalated after the 300ms grace period, as the runner never acked
      expect(h.states.at(-1)).toEqual({ state: "killed", activeHandles: undefined });
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
