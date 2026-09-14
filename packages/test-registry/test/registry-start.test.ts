import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestRegistry } from "../src/registry";

describe("startTestRegistry retry and diagnostics", () => {
  test("fails fast on a repeated early exit, retries exactly once, reports both exit codes and log tails, and removes the root", async () => {
    const root = await mkdtemp(join(tmpdir(), "jslab-registry-test-"));
    let invocations = 0;
    const command = (): string[] => {
      invocations++;
      return [process.execPath, "-e", "console.log('boom-out'); console.error('boom-err'); process.exit(3)"];
    };

    const start = Date.now();
    let message = "";
    try {
      await startTestRegistry({ root, readyTimeoutMs: 10_000, command });
      throw new Error("expected startTestRegistry to reject");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(5000);
    expect(message).toContain("exited early");
    expect(message).toContain("3");
    expect(message).toContain("boom-out");
    expect(message).toContain("boom-err");
    expect(invocations).toBe(2);
    expect(existsSync(root)).toBe(false);
  });
});
