import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunEvent, RunState } from "@jslab/rpc-schema";
import { buildSettings, defaultSettings } from "@jslab/shared";
import type { BuildOptions, TransformOptions, TransformResult } from "@jslab/transform";
import { DEFAULT_BUILD_OPTIONS, transform } from "@jslab/transform";
import { BunRunnerProcess } from "../../src/main/runs/bun-runner-process";
import { RunCoordinator, type RunnerSettings } from "../../src/main/runs/run-coordinator";
import { SparePool } from "../../src/main/runs/spare-pool";
import type { RuntimeAdapter } from "../../src/main/runtimes/adapter";
import { createRuntimeRegistry } from "../../src/main/runtimes/registry";

const BOOTSTRAP = Bun.resolveSync("@jslab/runner-bun/bootstrap", import.meta.dir);

interface Harness {
  coordinator: RunCoordinator;
  events: RunEvent[];
  batches: RunEvent[][];
  states: { runId: string; state: RunState; activeHandles?: number }[];
  locks: Set<string>;
  settings: RunnerSettings;
  waitForState(state: RunState, runId?: string, timeoutMs?: number): Promise<void>;
  dir: string;
}

/** Injection points used by the race/fault tests below to make timing-sensitive bugs deterministic. */
interface HarnessHooks {
  onLockAdd?: (runId: string) => void;
  onDiagnostics?: (tabId: string, runId: string) => void;
  /** Called as soon as the spare pool asks for a runner, before `BunRunnerProcess.start` resolves. */
  onRunnerRequested?: () => void;
  onRunnerStart?: (runner: BunRunnerProcess) => void;
  transform?: (source: string, options: TransformOptions) => Promise<TransformResult>;
  /** A stand-in runner script (see fixtures/) instead of the real bootstrap. */
  bootstrapPath?: string;
  /** Called after each state is recorded, with every event forwarded to the UI so far. */
  onState?: (runId: string, state: RunState, events: readonly RunEvent[]) => void;
}

const harnesses: Harness[] = [];

async function createHarness(overrides: Partial<RunnerSettings> = {}, hooks: HarnessHooks = {}): Promise<Harness> {
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
  const batches: RunEvent[][] = [];
  const states: Harness["states"] = [];
  const locks = new Set<string>();
  const spares = new SparePool(
    async (config) => {
      hooks.onRunnerRequested?.();
      const runner = await BunRunnerProcess.start(config);
      hooks.onRunnerStart?.(runner);
      return runner;
    },
    () => ({
      bunPath: process.execPath,
      bootstrapPath: hooks.bootstrapPath ?? BOOTSTRAP,
      cwd: dir,
      env: { PATH: process.env.PATH ?? "", JSLAB_HEARTBEAT_MS: "50" },
    }),
  );
  const coordinator = new RunCoordinator({
    transform: hooks.transform ?? (async (source, options) => transform(source, options)),
    spares,
    runsDir: join(dir, "runs"),
    settings: () => settings,
    onEvents: (_tab, _run, batch) => {
      batches.push(batch);
      events.push(...batch);
    },
    onState: (_tab, runId, state, activeHandles) => {
      states.push({ runId, state, activeHandles });
      hooks.onState?.(runId, state, events);
    },
    onDiagnostics: (tabId, runId) => hooks.onDiagnostics?.(tabId, runId),
    runLock: {
      add: (id) => {
        locks.add(id);
        hooks.onLockAdd?.(id);
      },
      remove: (id) => locks.delete(id),
    },
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
  const harness = { coordinator, events, batches, states, locks, settings, waitForState, dir };
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

  test("a transform failure fails the run instead of hanging", async () => {
    const h = await createHarness(
      {},
      {
        transform: async () => {
          throw new Error("boom-transform");
        },
      },
    );
    const { runId } = h.coordinator.start({ tabId: "t1", code: "1 + 1", language: "typescript", logpoints: [] });
    await h.waitForState("failed", runId);
    const errorEvents = h.events.filter((e) => e.kind === "error");
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0]).toMatchObject({ phase: "runner", message: "boom-transform" });
    expect(h.locks.size).toBe(0);
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
    const runners: BunRunnerProcess[] = [];
    const h = await createHarness({}, { onRunnerStart: (runner) => runners.push(runner) });
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
    expect(runners.length).toBeGreaterThanOrEqual(1);
    await runners[0]?.exited;
  }, 15_000);

  test("a run superseded after transpiling does not disturb the newer run", async () => {
    // Racy by nature (a stale run's fs writes/cleanup interleave with the newer run's): repeat a few times so a
    // regression is reliably caught even though a single iteration isn't guaranteed to hit the bad interleaving.
    for (let attempt = 0; attempt < 5; attempt++) {
      const ctx: { coordinator?: RunCoordinator } = {};
      let firstRunId = "";
      let superseded = false;
      const h = await createHarness(
        {},
        {
          onDiagnostics: (_tabId, runId) => {
            if (runId === firstRunId && !superseded) {
              superseded = true;
              ctx.coordinator?.start({ tabId: "t1", code: "1 + 1", language: "typescript", logpoints: [] });
            }
          },
        },
      );
      ctx.coordinator = h.coordinator;
      const first = h.coordinator.start({
        tabId: "t1",
        code: "const a: number = 1;\nconst b: number = 2;\na + b",
        language: "typescript",
        logpoints: [],
      });
      firstRunId = first.runId;
      await h.waitForState("idle");
      expect(h.events.filter((e) => e.kind === "error")).toEqual([]);
      h.coordinator.dispose();
      await rm(h.dir, { recursive: true, force: true });
    }
  }, 15_000);

  test("disposing during a run does not leave runners behind", async () => {
    const runners: BunRunnerProcess[] = [];
    let requested!: () => void;
    const runnerRequested = new Promise<void>((resolve) => {
      requested = resolve;
    });
    const h = await createHarness(
      {},
      { onRunnerRequested: () => requested(), onRunnerStart: (runner) => runners.push(runner) },
    );
    h.coordinator.start({ tabId: "t1", code: "1 + 1", language: "typescript", logpoints: [] });
    await runnerRequested;
    h.coordinator.dispose();
    await Bun.sleep(1500);
    expect(runners.length).toBeGreaterThan(0);
    for (const runner of runners) {
      const outcome = await Promise.race([runner.exited.then(() => "exited"), Bun.sleep(500).then(() => "timeout")]);
      expect(outcome).toBe("exited");
    }
  }, 15_000);

  /**
   * Final review, finding D. `disposeTab` resolved its adapter with `#registry.get(undefined)`, which always
   * returns the Bun adapter -- so closing a browser tab called `BunAdapter.dispose` (a no-op for a tab that never
   * took a spare) and **never** `WebAdapter.dispose`, leaving the webview undestroyed and Main's own entry in
   * place. Contrast `invalidate`, which was routed correctly all along.
   *
   * `web-adapter.test.ts`'s own "dispose() destroys the tab's webview" passes against the adapter in isolation and
   * cannot see that nothing in production ever reaches it, so this asserts the wiring rather than the adapter.
   */
  test("closing a tab disposes it on every registered adapter, not just Bun's", () => {
    const disposedByBun: string[] = [];
    const disposedByBrowser: string[] = [];
    const adapter = (id: RuntimeAdapter["id"], seen: string[]): RuntimeAdapter => ({
      id,
      prepare: async () => {},
      start: async () => {
        throw new Error("no run is started by this test");
      },
      invalidate: () => {},
      dispose: async (tabId) => void seen.push(tabId),
    });
    const coordinator = new RunCoordinator({
      transform: async () => {
        throw new Error("nothing is transformed by this test");
      },
      spares: {
        take: async () => {
          throw new Error("no spare is taken by this test");
        },
        prepare: () => {},
        invalidate: () => {},
        dispose: () => {},
      },
      runsDir: join(tmpdir(), "jslab-dispose-routing"),
      settings: () => ({
        autoLog: true,
        loopProtection: true,
        loopProtectionMaxIterations: 2000,
        maxEntries: 10_000,
        unresponsiveTimeoutMs: 400,
      }),
      onEvents: () => {},
      onState: () => {},
      onDiagnostics: () => {},
      runLock: { add: () => {}, remove: () => {} },
      watchdogIntervalMs: 100_000,
      runtimes: createRuntimeRegistry({
        bun: adapter("bun", disposedByBun),
        browser: adapter("browser", disposedByBrowser),
      }),
    });

    try {
      coordinator.disposeTab("t1");

      // The half that was dead in production.
      expect(disposedByBrowser).toEqual(["t1"]);
      expect(disposedByBun).toEqual(["t1"]);
    } finally {
      coordinator.dispose();
    }
  });

  test("closing a tab while a runner is being taken leaves no runners behind", async () => {
    // onRunnerRequested fires while take() is awaiting the spare, which is the window this test is named for.
    const runners: BunRunnerProcess[] = [];
    let requested!: () => void;
    const runnerRequested = new Promise<void>((resolve) => {
      requested = resolve;
    });
    const h = await createHarness(
      {},
      { onRunnerRequested: () => requested(), onRunnerStart: (runner) => runners.push(runner) },
    );
    h.coordinator.start({ tabId: "t1", code: "1 + 1", language: "typescript", logpoints: [] });
    await runnerRequested;
    h.coordinator.disposeTab("t1"); // deliberately not coordinator.dispose(): that path is already covered above.
    await Bun.sleep(2000);
    expect(runners.length).toBeGreaterThan(0);
    for (const runner of runners) {
      const outcome = await Promise.race([runner.exited.then(() => "exited"), Bun.sleep(500).then(() => "timeout")]);
      expect(outcome).toBe("exited");
    }
  }, 15_000);

  test("stop right after the runner is assigned stops the runner and releases the lock", async () => {
    const ctx: { coordinator?: RunCoordinator } = {};
    let capturedRunner: BunRunnerProcess | undefined;
    const h = await createHarness(
      {},
      {
        onLockAdd: () => ctx.coordinator?.stop("t1"),
        // Capture only the first runner: SparePool.take() prepares a fresh background spare for the *next* run
        // right after handing this one over, and that unrelated spare is expected to stay alive.
        onRunnerStart: (runner) => {
          capturedRunner ??= runner;
        },
      },
    );
    ctx.coordinator = h.coordinator;
    const { runId } = h.coordinator.start({ tabId: "t1", code: "1 + 1", language: "typescript", logpoints: [] });
    const started = Date.now();
    while (!h.states.some((s) => s.runId === runId && (s.state === "stopped" || s.state === "killed"))) {
      if (Date.now() - started > 8000)
        throw new Error(`timed out waiting for stopped/killed; saw ${JSON.stringify(h.states)}`);
      await Bun.sleep(10);
    }
    expect(h.locks.size).toBe(0);
    expect(capturedRunner).toBeDefined();
    const exited = await Promise.race([
      capturedRunner?.exited.then(() => "exited"),
      Bun.sleep(1000).then(() => "timeout"),
    ]);
    expect(exited).toBe("exited");
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
    await Bun.sleep(400); // longer than the harness's stopGraceMs (300ms): the grace timer must not still fire.
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

  test("recovering from unresponsive restores the settled state", async () => {
    // loopProtection must be off: it counts iterations, not wall-clock time, and would throw almost immediately
    // on this wall-clock-bounded busy loop instead of letting it actually block the runner for ~900ms.
    const h = await createHarness({ loopProtection: false });
    const { runId } = h.coordinator.start({
      tabId: "t1",
      code: [
        "setInterval(() => {}, 1000);",
        "setTimeout(() => {",
        "  const end = Date.now() + 900;",
        "  while (Date.now() < end) {}",
        "}, 0);",
      ].join("\n"),
      language: "typescript",
      logpoints: [],
    });
    await h.waitForState("unresponsive", runId);
    // The busy loop blocks the runner's event loop for ~900ms; give it time to finish and resume heartbeats.
    await Bun.sleep(1200);
    const runStates = h.states.filter((s) => s.runId === runId).map((s) => s.state);
    expect(runStates).toContain("settled");
    expect(runStates).toContain("unresponsive");
    expect(runStates.at(-1)).toBe("settled");
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

  // Task 15 (spec §5.12, EX-35): `RunCoordinator.mute()` is a harmless no-op for a runtime whose `RunHandle` has no
  // `mute` method at all (only `WebAdapter`'s sessions implement it) -- Bun has no audio concept, and the tab's
  // saved preference still persists in session.json (packages/shared) regardless of what's currently running.
  test("mute() is a harmless no-op when the running handle has no mute concept (Bun)", async () => {
    const h = await createHarness();
    const { runId } = h.coordinator.start({ tabId: "t1", code: "1 + 1", language: "typescript", logpoints: [] });
    await h.waitForState("idle", runId);
    expect(() => h.coordinator.mute("t1", true)).not.toThrow();
  }, 15_000);

  test("mute() is a harmless no-op when nothing is running for that tab", async () => {
    const h = await createHarness();
    expect(() => h.coordinator.mute("no-such-tab", true)).not.toThrow();
  });

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

  test("Kill after the runner already exited treats the runner as gone", async () => {
    const h = await createHarness();
    const { runId } = h.coordinator.start({
      tabId: "t1",
      code: "process.exit(3)",
      language: "typescript",
      logpoints: [],
    });
    await h.waitForState("failed", runId);
    h.coordinator.kill("t1");
    await flush();
    expect(h.states.filter((s) => s.runId === runId).at(-1)?.state).toBe("failed");
    expect(h.states.some((s) => s.runId === runId && s.state === "killed")).toBe(false);
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

  test("forwards run events to the UI in batches of at most 200", async () => {
    const h = await createHarness({}, { bootstrapPath: join(import.meta.dir, "fixtures/burst-runner.ts") });
    const { runId } = h.coordinator.start({ tabId: "t1", code: "1", language: "typescript", logpoints: [] });
    await h.waitForState("idle", runId);
    await flush();
    expect(h.events).toHaveLength(450);
    expect(Math.max(...h.batches.map((batch) => batch.length))).toBeLessThanOrEqual(200);
    expect(h.events.map((e) => e.seq)).toEqual(Array.from({ length: 450 }, (_, i) => i + 1));
  }, 15_000);

  test("does not forward events a runner sends after it reports stopped", async () => {
    const h = await createHarness({}, { bootstrapPath: join(import.meta.dir, "fixtures/chatty-runner.ts") });
    const { runId } = h.coordinator.start({ tabId: "t1", code: "1", language: "typescript", logpoints: [] });
    await h.waitForState("evaluating", runId);
    h.coordinator.stop("t1");
    await h.waitForState("stopped", runId);
    const forwarded = h.events.length;
    await Bun.sleep(200);
    expect(h.events).toHaveLength(forwarded);
  }, 15_000);

  test("a pending expand resolves to null as soon as the runner exits", async () => {
    const h = await createHarness({}, { bootstrapPath: join(import.meta.dir, "fixtures/expand-exit-runner.ts") });
    const { runId } = h.coordinator.start({ tabId: "t1", code: "1", language: "typescript", logpoints: [] });
    await h.waitForState("idle", runId);
    const started = Date.now();
    const outcome = await Promise.race([
      h.coordinator.expand("t1", runId, "h1").then((value) => ({ value })),
      Bun.sleep(2000).then(() => "timeout" as const),
    ]);
    expect(outcome).toEqual({ value: null });
    expect(Date.now() - started).toBeLessThan(1000);
  }, 15_000);

  // OU-02: the coordinator's own forwarding hop. Nothing else in this change reaches it -- `rpc-handlers.test.ts`
  // mocks the coordinator away, and the adapter tests call `RunHandle.expand` directly -- so without this, dropping
  // `offset` in `RunCoordinator.expand` would leave every other test green while every page request silently asked
  // for page 1 again. The stand-in runner echoes back the offset it received, so no 10,000-entry collection is
  // needed to observe it.
  test("expand forwards the caller's offset to the runner, and forwards its absence as absence (OU-02)", async () => {
    const h = await createHarness({}, { bootstrapPath: join(import.meta.dir, "fixtures/expand-echo-runner.ts") });
    const { runId } = h.coordinator.start({ tabId: "t1", code: "1", language: "typescript", logpoints: [] });
    await h.waitForState("idle", runId);
    expect(await h.coordinator.expand("t1", runId, "h1", 10_000)).toEqual({ t: "number", v: "10000" });
    // A genuine 0 must arrive as 0 rather than being conflated with "no offset" -- the fixture reports -1 for an
    // absent field, so these two assertions cannot both pass unless the value really crossed the wire.
    expect(await h.coordinator.expand("t1", runId, "h1", 0)).toEqual({ t: "number", v: "0" });
    expect(await h.coordinator.expand("t1", runId, "h1")).toEqual({ t: "number", v: "-1" });
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

  test("a clean process.exit(0) ends the run as idle, and a crash names its signal (final review M5)", async () => {
    const h = await createHarness();
    const clean = h.coordinator.start({ tabId: "t1", code: "process.exit(0)", language: "javascript", logpoints: [] });
    await h.waitForState("idle", clean.runId);
    await flush();
    expect(h.events.filter((e) => e.kind === "error")).toEqual([]);
    const killed = h.coordinator.start({
      tabId: "t1",
      code: "process.kill(process.pid, 'SIGTERM')",
      language: "javascript",
      logpoints: [],
    });
    await h.waitForState("failed", killed.runId);
    await flush();
    expect(h.events.find((e) => e.kind === "error")).toMatchObject({
      phase: "runner",
      message: expect.stringContaining("signal SIGTERM"),
    });
  }, 15_000);

  test("a clean process.exit(0) while stopping reports stopped, not idle (FA-m3)", async () => {
    const h = await createHarness({}, { bootstrapPath: join(import.meta.dir, "fixtures/exit-on-stop-runner.ts") });
    const { runId } = h.coordinator.start({ tabId: "t1", code: "1", language: "typescript", logpoints: [] });
    await h.waitForState("evaluating", runId);
    h.coordinator.stop("t1");
    await h.waitForState("stopped", runId, 3000);
    // Past the 300 ms stop grace, so a kill escalation or a late state would show up here.
    await Bun.sleep(400);
    expect(h.states.filter((s) => s.runId === runId).map((s) => s.state)).toEqual([
      "transpiling",
      "evaluating",
      "stopping",
      "stopped",
    ]);
  }, 15_000);

  // Task 9d: `lastHeartbeatAt` was stamped at run creation and refreshed only by a `heartbeat` message, but
  // transpiling and bundling happen in between. `#checkHeartbeats` skips a run only until its handle attaches --
  // it defers the judgement without refreshing the stale stamp -- so the instant `attached:` fired, a creation-time
  // stamp already older than `unresponsiveTimeoutMs` was judged and the user saw the unresponsive prompt for a run
  // that had only just begun. This runner never sends a heartbeat, so Main stamping the attach itself is the only
  // thing that can keep the run out of that state.
  test("a run whose preparation outlasts the unresponsive timeout is not declared unresponsive the moment it starts", async () => {
    const h = await createHarness(
      { unresponsiveTimeoutMs: 300 },
      {
        bootstrapPath: join(import.meta.dir, "fixtures/silent-runner.ts"),
        transform: async (source, options) => {
          // Deliberately longer than the unresponsive timeout, so the creation-time stamp is already stale by the
          // time a handle exists to judge it against.
          await Bun.sleep(600);
          return transform(source, options);
        },
      },
    );
    const { runId } = h.coordinator.start({ tabId: "t1", code: "1", language: "typescript", logpoints: [] });
    await h.waitForState("evaluating", runId);
    // Comfortably past the 50 ms watchdog interval (so a stale stamp would already have been judged) and well
    // inside the fresh 300 ms window an attach-time stamp buys.
    await Bun.sleep(100);
    expect(h.states.filter((s) => s.runId === runId).map((s) => s.state)).toEqual(["transpiling", "evaluating"]);
  }, 15_000);

  test("output logged right before process.exit(0) reaches the UI before the run settles, 20 runs plus near-256 KB final flushes (FA-I4, spec §5.11)", async () => {
    // The text of the last console event the UI had received when each run reported "idle".
    const lastAtIdle = new Map<string, string | null>();
    const lastConsoleText = (events: readonly RunEvent[]) => {
      for (let i = events.length - 1; i >= 0; i--) {
        const event = events[i];
        if (event?.kind === "console" && event.args[0]?.t === "string") return event.args[0].v;
      }
      return null;
    };
    const h = await createHarness(
      {},
      { onState: (runId, state, events) => state === "idle" && lastAtIdle.set(runId, lastConsoleText(events)) },
    );
    const exitAfter = async (code: string, marker: string) => {
      const { runId } = h.coordinator.start({ tabId: "t1", code, language: "javascript", logpoints: [] });
      await h.waitForState("idle", runId);
      expect(lastAtIdle.get(runId)).toBe(marker);
    };
    const started = Date.now();
    // 300 lines: the first 200 flush early, the rest (and the marker) only in the runner's exit listener.
    for (let run = 0; run < 20; run++) {
      await exitAfter(
        `for (let i = 0; i < 300; i++) console.log("line " + i);\nconsole.log("done ${run}");\nprocess.exit(0);`,
        `done ${run}`,
      );
    }
    // 180 events of about 1.4 KB each: a final flush of roughly 250 KB, just under the 256 KB early-flush size.
    for (let run = 0; run < 5; run++) {
      await exitAfter(
        `const row = "x".repeat(1300);\nfor (let i = 0; i < 179; i++) console.log(row);\nconsole.log("big ${run}");\nprocess.exit(0);`,
        `big ${run}`,
      );
    }
    console.info(`[FA-I4] 25 exit runs in ${Date.now() - started} ms`);
  }, 60_000);

  test("a stopped run's runner is recycled once Stop is acknowledged (R-M1-18)", async () => {
    const started: BunRunnerProcess[] = [];
    const h = await createHarness({}, { onRunnerStart: (runner) => started.push(runner) });
    const { runId } = h.coordinator.start({
      tabId: "t1",
      code: "console.log(String(process.pid));\nsetInterval(() => {}, 10);",
      language: "typescript",
      logpoints: [],
    });
    await h.waitForState("settled", runId);
    await flush();
    const logged = h.events.find((e) => e.kind === "console");
    const pid = logged?.kind === "console" && logged.args[0]?.t === "string" ? Number(logged.args[0].v) : 0;
    const runner = started.find((candidate) => candidate.pid === pid);
    expect(runner).toBeDefined();
    // Kill in the window between the "stopped" message and the runner's exit must not turn "stopped" into "killed".
    // This listener runs right after the coordinator's own handler for the same message.
    runner?.onMessage((message) => {
      if (message.type === "state" && message.state === "stopped") h.coordinator.kill("t1");
    });
    h.coordinator.stop("t1");
    await h.waitForState("stopped", runId);
    const outcome = await Promise.race([runner?.exited.then(() => "exited"), Bun.sleep(2000).then(() => "alive")]);
    expect(outcome).toBe("exited");
    expect(h.states.some((s) => s.runId === runId && s.state === "killed")).toBe(false);
    expect(h.events.filter((e) => e.kind === "error")).toEqual([]);
  }, 15_000);

  test("build settings reach the transform (spec §8 Build)", async () => {
    // R-M3-T15-TYPES-1: fails typecheck if @jslab/shared's BuildSettings and @jslab/transform's BuildOptions diverge.
    const buildTypeGuard: BuildOptions = buildSettings(defaultSettings());
    expect(buildTypeGuard.decorators).toBe("2023-11");
    const seen: TransformOptions[] = [];
    const harness = await createHarness(
      { build: { ...DEFAULT_BUILD_OPTIONS, pipelineOperator: true } },
      {
        transform: async (source, options) => {
          seen.push(options);
          return transform(source, options);
        },
      },
    );
    const { runId } = harness.coordinator.start({
      tabId: "t1",
      code: "1 |> % + 1",
      language: "typescript",
      logpoints: [],
    });
    await harness.waitForState("idle", runId);
    expect(seen[0]?.build?.pipelineOperator).toBe(true);
    expect(harness.events.find((event) => event.kind === "result")).toMatchObject({ value: { t: "number", v: "2" } });
  });
});
