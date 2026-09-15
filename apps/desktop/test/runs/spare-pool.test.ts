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

  test("invalidateAll recycles every tab's spare and re-warms only the active tab (spec §11.3, §12.1)", async () => {
    const { pool, started } = fakePool();
    pool.prepare("a");
    pool.setActiveTab("b");
    await Bun.sleep(0);
    pool.invalidateAll();
    await Bun.sleep(0);
    expect(started.map((runner) => runner.cwd)).toEqual(["/runs/a", "/runs/b", "/runs/b"]);
    expect(started[1]?.kill).toHaveBeenCalledTimes(1);
    expect(started[2]?.kill).not.toHaveBeenCalled();
    pool.dispose();
  });

  test("an in-flight take on a never-invalidated tab sees invalidateAll", async () => {
    let value = "old";
    const started: { env: string; kill: ReturnType<typeof mock> }[] = [];
    let releaseFirst = () => {};
    const pool = new SparePool(
      (config: RunnerSpawnConfig) => {
        const kill = mock(() => {});
        const runner = { kill, startedWith: config.env.V } as unknown as BunRunnerProcess;
        started.push({ env: config.env.V ?? "", kill });
        if (started.length > 1) return Promise.resolve(runner);
        return new Promise<BunRunnerProcess>((resolve) => {
          releaseFirst = () => resolve(runner);
        });
      },
      (tabId) => ({ bunPath: "bun", bootstrapPath: "bootstrap.js", cwd: `/runs/${tabId}`, env: { V: value } }),
    );
    const taking = pool.take("a");
    value = "new";
    pool.invalidateAll();
    releaseFirst();
    const runner = (await taking) as unknown as { startedWith: string };
    expect(runner.startedWith).toBe("new");
    expect(started[0]?.env).toBe("old");
    expect(started[0]?.kill).toHaveBeenCalledTimes(1);
    pool.dispose();
  });
});
