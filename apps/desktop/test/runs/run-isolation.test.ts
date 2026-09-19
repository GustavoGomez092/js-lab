import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRunHarness, NL, type RunHarness } from "./run-harness";

/**
 * EX-06 (spec §5.1, §5.12): "state doesn't persist between runs" -- a fresh process/realm per run, so nothing a
 * script defines in run N is visible in run N+1.
 *
 * The parity row was 🚧 with "no direct test that two runs get distinct fresh state". The pre-existing nearest
 * thing, `run-coordinator.test.ts`'s "supersedes a running run and kills its runner", asserts only that the
 * *superseded* runner exits, and counts runners with `toBeGreaterThanOrEqual(1)` -- which holds even if both runs
 * shared one process.
 *
 * Every assertion below is made from **inside the run**: the code reports its own `process.pid`, its own view of
 * `globalThis`, its own module instance. That is deliberate. An assertion phrased against Main's own record of
 * which process it spawned would be checking the implementation against the same lookup the implementation used,
 * and would survive isolation being switched off; asking the running code what it can actually see cannot.
 *
 * Bun isolates by process: `BunAdapter.start` takes a fresh `SparePool` spare for every run, and the runner's own
 * `startRun` refuses a second run in the same process outright (`if (run) return`). These tests pin the observable
 * consequence rather than either mechanism, so they stay honest if the mechanism is ever reworked.
 */

let h: RunHarness | null = null;

afterEach(async () => {
  await h?.dispose();
  h = null;
});

const TERMINAL = ["idle", "settled", "failed"] as const;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("run isolation (EX-06, spec §5.1, §5.12) -- Bun runtime", () => {
  test("a global assigned in one run is absent in the next", async () => {
    h = await createRunHarness();
    const first = h.start(['globalThis.leakProbe = "from run 1";', 'console.log("run 1 done");'].join(NL));
    await h.waitFor(first.runId, [...TERMINAL]);
    expect(h.errorsFor(first.runId)).toEqual([]);
    // The control: run 1 really did execute the assignment, so run 2 seeing nothing means isolation, not a no-op.
    expect(h.consoleTextFor(first.runId)).toEqual(["run 1 done"]);

    const second = h.start("console.log(String(globalThis.leakProbe));");
    await h.waitFor(second.runId, [...TERMINAL]);
    expect(h.errorsFor(second.runId)).toEqual([]);
    expect(h.consoleTextFor(second.runId)).toEqual(["undefined"]);
  }, 30_000);

  test("a module's top-level state does not carry over through a module cache", async () => {
    h = await createRunHarness();
    const modulePath = join(h.dir, "counter.mjs");
    await Bun.write(modulePath, ["let calls = 0;", "export const bump = () => ++calls;", ""].join(NL));
    const specifier = JSON.stringify(pathToFileURL(modulePath).href);
    // The same module, imported by both runs. A shared module registry would hand run 2 the instance run 1 already
    // mutated, and `bump()` would answer 2.
    const source = [`const m = await import(${specifier});`, "console.log(String(m.bump()));"].join(NL);

    const first = h.start(source);
    await h.waitFor(first.runId, [...TERMINAL]);
    expect(h.errorsFor(first.runId)).toEqual([]);
    expect(h.consoleTextFor(first.runId)).toEqual(["1"]);

    const second = h.start(source);
    await h.waitFor(second.runId, [...TERMINAL]);
    expect(h.errorsFor(second.runId)).toEqual([]);
    expect(h.consoleTextFor(second.runId)).toEqual(["1"]);
  }, 30_000);

  test("an interval left running by one run does not keep ticking into the next", async () => {
    h = await createRunHarness();
    const tickFile = join(h.dir, "ticks.txt");
    const tickPath = JSON.stringify(tickFile);
    // Run 1 never finishes cleanly: it leaves a live interval behind, so it reaches `settled`, not `idle`.
    const first = h.start(
      ['import { appendFileSync } from "node:fs";', `setInterval(() => appendFileSync(${tickPath}, "x"), 5);`].join(NL),
    );
    await h.waitFor(first.runId, ["settled", "idle", "failed"]);
    expect(h.errorsFor(first.runId)).toEqual([]);

    // Run 2 measures the file across a window far longer than the 5 ms interval. A surviving timer shows up as
    // growth; `before > 0` is the control proving the interval genuinely ran during run 1, so a file that never
    // grew because the interval never started cannot masquerade as isolation.
    const second = h.start(
      [
        'import { statSync } from "node:fs";',
        `const size = () => statSync(${tickPath}).size;`,
        "await new Promise((r) => setTimeout(r, 200));",
        "const before = size();",
        "await new Promise((r) => setTimeout(r, 200));",
        "console.log(JSON.stringify({ before, after: size() }));",
      ].join(NL),
    );
    await h.waitFor(second.runId, [...TERMINAL]);
    expect(h.errorsFor(second.runId)).toEqual([]);
    const measured = JSON.parse(h.consoleTextFor(second.runId)[0] ?? "{}") as { before: number; after: number };
    expect(measured.before).toBeGreaterThan(0);
    expect(measured.after).toBe(measured.before);
  }, 30_000);

  test("two runs report two different process ids, and the first process is gone", async () => {
    h = await createRunHarness();
    const source = "console.log(String(process.pid));";

    const first = h.start(source);
    await h.waitFor(first.runId, [...TERMINAL]);
    expect(h.errorsFor(first.runId)).toEqual([]);
    const firstPid = Number(h.consoleTextFor(first.runId)[0]);
    expect(Number.isInteger(firstPid)).toBe(true);

    const second = h.start(source);
    await h.waitFor(second.runId, [...TERMINAL]);
    expect(h.errorsFor(second.runId)).toEqual([]);
    const secondPid = Number(h.consoleTextFor(second.runId)[0]);
    expect(Number.isInteger(secondPid)).toBe(true);

    expect(secondPid).not.toBe(firstPid);
    // Starting run 2 supersedes run 1, which kills its runner: the first process must not outlive its run.
    const deadline = Date.now() + 5000;
    while (alive(firstPid) && Date.now() < deadline) await Bun.sleep(20);
    expect(alive(firstPid)).toBe(false);
  }, 30_000);
});
