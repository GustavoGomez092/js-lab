import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBunSpawn } from "../../src/main/services/npm-spawn";

describe("createBunSpawn (spec §11.3, fix round 1 M-6/M-5d)", () => {
  test("createBunSpawn keeps a trailing multi-byte character and aborts a running child", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jslab-npm-spawn-"));
    const spawn = createBunSpawn(process.execPath);
    const env: Record<string, string> = { PATH: process.env.PATH ?? "" };
    try {
      // Part (a): a trailing multi-byte character (never typed in source) must survive the capture unmangled.
      const accent = String.fromCharCode(233);
      const word = `caf${accent}`;
      const script = `process.stdout.write(${JSON.stringify(word)})`;
      const result = await spawn(["-e", script], {
        cwd: dir,
        env,
        signal: new AbortController().signal,
        onOutput: () => {},
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.endsWith(accent)).toBe(true);
      expect(result.stdout).toBe(word);

      // Part (b): an abort must kill the child (by the adapter's own tracked process) within a few seconds.
      const controller = new AbortController();
      const startedAt = Date.now();
      const slow = spawn(["-e", "setTimeout(() => {}, 30000)"], {
        cwd: dir,
        env,
        signal: controller.signal,
        onOutput: () => {},
      });
      await Bun.sleep(100);
      controller.abort();
      const killed = await slow;
      expect(Date.now() - startedAt).toBeLessThan(5000);
      expect(killed.exitCode === null || killed.exitCode !== 0).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
