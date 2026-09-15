import { describe, expect, mock, test } from "bun:test";
import type { BunRunnerProcess, RunnerSpawnConfig } from "../../src/main/runs/bun-runner-process";
import { SparePool } from "../../src/main/runs/spare-pool";

function fakePool() {
  const started: { cwd: string; kill: ReturnType<typeof mock> }[] = [];
  const pool = new SparePool(
    async (config: RunnerSpawnConfig) => {
      const kill = mock(() => {});
      started.push({ cwd: config.cwd, kill });
      return { kill } as unknown as BunRunnerProcess;
    },
    (tabId) => ({ bunPath: "bun", bootstrapPath: "bootstrap.js", cwd: `/runs/${tabId}`, env: {} }),
  );
  return { pool, started };
}

describe("SparePool", () => {
  test("pre-warms only the active tab: activation discards other spares, and a background take doesn't re-warm", async () => {
    const { pool, started } = fakePool();
    pool.prepare("a");
    pool.setActiveTab("b");
    await Bun.sleep(0);
    expect(started.map((runner) => runner.cwd)).toEqual(["/runs/a", "/runs/b"]);
    expect(started[0]?.kill).toHaveBeenCalledTimes(1);
    expect(started[1]?.kill).not.toHaveBeenCalled();
    await pool.take("a");
    await Bun.sleep(0);
    expect(started.map((runner) => runner.cwd)).toEqual(["/runs/a", "/runs/b", "/runs/a"]);
    await pool.take("b");
    await Bun.sleep(0);
    expect(started.map((runner) => runner.cwd)).toEqual(["/runs/a", "/runs/b", "/runs/a", "/runs/b"]);
    pool.dispose();
  });
});
