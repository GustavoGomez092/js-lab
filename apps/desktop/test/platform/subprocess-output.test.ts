import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_SHORT_SUBPROCESS_OUTPUT_BYTES,
  MAX_SYSTEM_PROFILER_OUTPUT_BYTES,
  SUBPROCESS_READ_GRANULARITY_BYTES,
} from "../../src/main/platform/subprocess-output";

/**
 * Every helper Main spawns is looked up on PATH by bare name (`osascript`, `system_profiler`, `screencapture`),
 * so a fixture directory placed first on PATH substitutes a flooding stand-in for the real binary WITHOUT any
 * production seam: these tests drive the real `saveDialog`/`runSystemProfiler`/`captureWindow`/`readModifierFlags`
 * over their real `Bun.spawn` calls.
 *
 * Each measurement runs in a CHILD process, and that is load-bearing rather than tidy. RSS never shrinks, so once
 * one test in this file has mapped hundreds of megabytes, a second unbounded read reuses those pages and an
 * in-process delta collapses towards zero -- the assertion would then pass under the mutant while proving only
 * the order the tests ran in. A child process has its own baseline.
 *
 * The error type cannot stand in for the memory assertion: with the cap removed, every one of these sites still
 * ends in the same error (or the same success) it ends in with the cap present. Only the cost differs.
 */

const MB = 1024 * 1024;
/** The stand-in emits this much before giving up, so a mutant costs bounded (if large) memory instead of the box. */
const FLOOD_MB = 600;
/** Fixed: the cap plus one 64 KiB read, a few MB with decode overhead. Mutant: 600 MiB of bytes plus its string. */
const SHORT_CAP_MAX_DELTA_MB = 64;
/** Fixed: 32 MiB retained, so bytes plus string. Mutant: the full 600 MiB flood the same way. */
const PROFILER_MAX_DELTA_MB = 256;

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jslab-subproc-cap-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A stand-in binary that floods one stream with `FLOOD_MB` of zero bytes and then fails. */
async function writeFlooder(name: string, stream: "stdout" | "stderr"): Promise<void> {
  const redirect = stream === "stderr" ? ">&2" : "";
  const path = join(dir, name);
  await writeFile(path, `#!/bin/sh\n/bin/dd if=/dev/zero bs=1048576 count=${FLOOD_MB} ${redirect}\nexit 1\n`);
  await chmod(path, 0o755);
}

interface Measurement {
  delta: number;
  out: string;
}

/**
 * Runs `script` in a child whose PATH finds the fixture first, and reports the child's own RSS delta. The 3 s
 * bound is deliberately under bun's 5 s per-test timeout: past it the timeout would preempt this race and the
 * SIGKILL below would never run, leaking a flooding child.
 */
async function measure(script: string): Promise<Measurement> {
  const child = Bun.spawn([process.execPath, "-e", script], {
    stdout: "pipe",
    stderr: "ignore",
    maxBuffer: MAX_SHORT_SUBPROCESS_OUTPUT_BYTES,
    env: { ...process.env, PATH: `${dir}:/usr/bin:/bin` },
  });
  const outcome = await Promise.race([child.exited.then(() => "exited"), Bun.sleep(3000).then(() => "blocked")]);
  if (outcome === "blocked") {
    child.kill("SIGKILL");
    await child.exited;
  }
  const out = await new Response(child.stdout).text();
  expect(outcome).toBe("exited");
  const delta = Number(/DELTA:(-?\d+)/.exec(out)?.[1] ?? Number.NaN);
  expect(Number.isNaN(delta)).toBe(false);
  return { delta, out };
}

/** The call is sampled around, and its result read only afterwards, so a mutant's buffer is still reachable. */
function scriptFor(module: string, body: string): string {
  return [
    `const mod = await import(${JSON.stringify(join(import.meta.dir, "..", "..", "src", "main", module))});`,
    `const before = process.memoryUsage().rss;`,
    `let result = "";`,
    `let err = "none";`,
    `try { result = ${body}; } catch (error) { err = String(error && error.name); }`,
    `const after = process.memoryUsage().rss;`,
    `console.log("LEN:" + String(result === null || result === undefined ? 0 : JSON.stringify(result).length));`,
    `console.log("ERR:" + err);`,
    `console.log("DELTA:" + Math.round((after - before) / ${MB}));`,
  ].join("\n");
}

describe("subprocess output caps (R-M5b-S3)", () => {
  test("the caps are the measured pipe-read granularity, and the profiler cap clears its real output", () => {
    // A cap under one pipe read would claim a tightness Bun cannot deliver; see subprocess-output.ts.
    expect(MAX_SHORT_SUBPROCESS_OUTPUT_BYTES).toBe(SUBPROCESS_READ_GRANULARITY_BYTES);
    // The real `system_profiler SPFontsDataType -json` measured 2,258,402 bytes; the cap must not refuse it.
    expect(MAX_SYSTEM_PROFILER_OUTPUT_BYTES).toBeGreaterThan(2_258_402);
  });

  test("saveDialog refuses a flooding osascript WITHOUT buffering its output", async () => {
    await writeFlooder("osascript", "stdout");
    const { delta, out } = await measure(
      scriptFor("platform/save-dialog", 'await mod.saveDialog({ defaultName: "x.ts" })'),
    );
    // It still fails the way it always failed -- which is exactly why the error cannot be the assertion.
    expect(out).toContain("ERR:Error");
    expect(delta).toBeLessThan(SHORT_CAP_MAX_DELTA_MB);
  });

  test("runSystemProfiler refuses a flooding system_profiler WITHOUT buffering its output", async () => {
    await writeFlooder("system_profiler", "stdout");
    const { delta, out } = await measure(scriptFor("platform/system-fonts", "await mod.runSystemProfiler()"));
    expect(out).toContain("ERR:Error");
    expect(delta).toBeLessThan(PROFILER_MAX_DELTA_MB);
  });

  test("captureWindow refuses a screencapture flooding stderr WITHOUT buffering it", async () => {
    await writeFlooder("screencapture", "stderr");
    // Awaiting `exited` first does not help: Bun drains the pipe eagerly, so the bytes are already Main's.
    const body = 'await mod.captureWindow(4242, "/dev/null", () => true)';
    const { delta, out } = await measure(scriptFor("platform/window-capture", body));
    expect(out).toContain("ERR:Error");
    expect(delta).toBeLessThan(SHORT_CAP_MAX_DELTA_MB);
  });

  test("readModifierFlags refuses a flooding osascript WITHOUT buffering its output", async () => {
    await writeFlooder("osascript", "stdout");
    // Called with no timeoutMs on purpose: no kill timer runs, so only the cap can end the child.
    const { delta, out } = await measure(scriptFor("services/safe-mode", "await mod.readModifierFlags()"));
    expect(out).toContain("ERR:Error");
    expect(delta).toBeLessThan(SHORT_CAP_MAX_DELTA_MB);
  });

  test("a truncated flags read is never parsed as a real answer", async () => {
    await writeFlooder("osascript", "stdout");
    // isShiftHeld swallows the refusal and reports "not held", rather than parsing whatever digits survived.
    const script = [
      `const mod = await import(${JSON.stringify(join(import.meta.dir, "..", "..", "src", "main", "services", "safe-mode"))});`,
      `console.log("HELD:" + String(await mod.isShiftHeld()));`,
      `console.log("DELTA:0");`,
    ].join("\n");
    const { out } = await measure(script);
    expect(out).toContain("HELD:false");
  });
});
