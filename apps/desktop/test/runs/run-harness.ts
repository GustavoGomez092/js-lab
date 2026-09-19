import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunEvent, RunState } from "@jslab/rpc-schema";
import { transform } from "@jslab/transform";
import { BunRunnerProcess } from "../../src/main/runs/bun-runner-process";
import { RunCoordinator, type RunStartRequest } from "../../src/main/runs/run-coordinator";
import { SparePool } from "../../src/main/runs/spare-pool";

/**
 * A minimal real-run harness: a real `SparePool`, real `BunRunnerProcess`es and the real transform, driven through
 * `RunCoordinator` exactly as Main drives it. Shared by `run-isolation.test.ts` (EX-06) and
 * `module-interop.test.ts` (EX-19), both of which are integration-level rows (parity Verify column `I`) and so
 * must go through a genuine runner process rather than a stand-in.
 *
 * Deliberately thinner than `run-coordinator.test.ts`'s harness: no injection hooks, because both callers assert on
 * what the *run itself reports* (its own `process.pid`, its own view of `globalThis`) rather than on Main-side
 * bookkeeping. An assertion that read Main's own record of which process it spawned would be comparing the
 * implementation against itself; asking the running code to report its own identity cannot.
 */

/** R-M3-T17-ESC-1: build test source newlines this way, never a "\n" escape typed through a tool parameter. */
export const NL = String.fromCharCode(10);

const BOOTSTRAP = Bun.resolveSync("@jslab/runner-bun/bootstrap", import.meta.dir);

export interface RunHarness {
  /** Starts a run on `tabId` (default "t1") and returns its runId, as `RunCoordinator.start` does. */
  start(code: string, overrides?: Partial<RunStartRequest>): { runId: string };
  waitFor(runId: string, wanted: RunState[], timeoutMs?: number): Promise<void>;
  /** Every `console.*` argument this run printed, stringified, in order. */
  consoleTextFor(runId: string): string[];
  /** Error events this run produced -- asserted empty so a silently failed run can never look like a pass. */
  errorsFor(runId: string): RunEvent[];
  /** A scratch directory the test may write fixture modules into. */
  dir: string;
  dispose(): Promise<void>;
}

export async function createRunHarness(): Promise<RunHarness> {
  // realpath removes the macOS /var symlink form: Bun 1.4.0's resolver can report "Cannot find module" for a file
  // written into a directory it already scanned when the path goes through that symlink (FLAKE-8).
  const dir = await realpath(await mkdtemp(join(tmpdir(), "jslab-run-harness-")));
  const records: { runId: string; event: RunEvent }[] = [];
  const states: { runId: string; state: RunState }[] = [];

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
    settings: () => ({
      autoLog: true,
      loopProtection: true,
      loopProtectionMaxIterations: 2000,
      maxEntries: 1000,
      unresponsiveTimeoutMs: 5000,
    }),
    onEvents: (_tabId, runId, batch) => {
      for (const event of batch) records.push({ runId, event });
    },
    onState: (_tabId, runId, state) => states.push({ runId, state }),
    onDiagnostics: () => {},
    runLock: { add: () => {}, remove: () => {} },
  });

  return {
    dir,
    start(code, overrides = {}) {
      return coordinator.start({ tabId: "t1", code, language: "typescript", logpoints: [], ...overrides });
    },
    async waitFor(runId, wanted, timeoutMs = 15_000) {
      const started = Date.now();
      while (!states.some((s) => s.runId === runId && wanted.includes(s.state))) {
        if (Date.now() - started > timeoutMs)
          throw new Error(`run ${runId} never reached ${wanted.join("/")}: ${JSON.stringify(states)}`);
        await Bun.sleep(20);
      }
      // The terminal state is sent after a buffer flush, but the flush crosses IPC as its own message: give the
      // events that were flushed with it a turn to arrive before a caller reads them.
      await Bun.sleep(60);
    },
    consoleTextFor(runId) {
      return records
        .filter((r) => r.runId === runId && r.event.kind === "console")
        .flatMap((r) =>
          (r.event as Extract<RunEvent, { kind: "console" }>).args.map((arg) => String((arg as { v?: unknown }).v)),
        );
    },
    errorsFor(runId) {
      return records.filter((r) => r.runId === runId && r.event.kind === "error").map((r) => r.event);
    },
    async dispose() {
      coordinator.dispose();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
