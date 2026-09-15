import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAppPaths } from "../src/main/app-paths";
import { createMainServices, type MainServices } from "../src/main/main-services";
import { createRpcHandlers, InvalidPayloadError } from "../src/main/rpc-handlers";
import type { BunRunnerProcess, RunnerSpawnConfig } from "../src/main/runs/bun-runner-process";

let dir = "";
let services: MainServices | null = null;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jslab-core-"));
});
afterEach(async () => {
  services?.dispose();
  services = null;
  await rm(dir, { recursive: true, force: true });
});

describe("main services (composition root)", () => {
  test("builds stores and the run coordinator without Electrobun, and the RPC handlers validate against them", async () => {
    const paths = resolveAppPaths({
      resourcesFolder: join(dir, "Resources"),
      userData: dir,
      execPath: process.execPath,
      env: {},
    });
    services = await createMainServices({
      paths,
      env: {},
      shiftHeld: Promise.resolve(false),
      realHome: join(dir, "home"),
      onEvents: () => {},
      onState: () => {},
      onDiagnostics: () => {},
      onNpmOperation: () => {},
      onNpmLog: () => {},
      onNpmChanged: () => {},
      startRunner: () => Promise.reject(new Error("no runners in this test")),
      transformHost: { transform: () => Promise.reject(new Error("no transforms in this test")), dispose: () => {} },
    });
    expect(services.safeMode).toEqual({ active: false, reason: null });
    expect(existsSync(paths.packagesJson)).toBe(true);
    expect(services.env.variables).toEqual({});
    const logged: string[] = [];
    const handlers = createRpcHandlers({
      coordinator: services.coordinator,
      settings: services.settings,
      session: services.session,
      safeMode: services.safeMode,
      versions: { app: "test", bun: Bun.version },
      log: (message) => logged.push(message),
      onUiHeartbeat: () => {},
    });
    const payload = await handlers.requests["app.bootstrap"]();
    expect(payload.session.tabOrder).toHaveLength(1);
    expect(payload.buffers).toEqual({ [payload.session.activeTabId]: "" });
    expect(() => handlers.requests["run.start"]({ tabId: payload.session.activeTabId, code: 1 })).toThrow(
      InvalidPayloadError,
    );
    expect(logged).toEqual(["Rejected invalid run.start payload"]);
  });

  test("saving env.json replaces the active tab's pre-started runner", async () => {
    const paths = resolveAppPaths({
      resourcesFolder: join(dir, "Resources"),
      userData: dir,
      execPath: process.execPath,
      env: {},
    });
    const started: { env: Record<string, string>; kill: ReturnType<typeof mock> }[] = [];
    services = await createMainServices({
      paths,
      env: {},
      shiftHeld: Promise.resolve(false),
      realHome: join(dir, "home"),
      onEvents: () => {},
      onState: () => {},
      onDiagnostics: () => {},
      onNpmOperation: () => {},
      onNpmLog: () => {},
      onNpmChanged: () => {},
      startRunner: async (config: RunnerSpawnConfig) => {
        const kill = mock(() => {});
        started.push({ env: config.env, kill });
        return { kill } as unknown as BunRunnerProcess;
      },
      transformHost: { transform: () => Promise.reject(new Error("no transforms in this test")), dispose: () => {} },
    });
    services.spares.setActiveTab(services.session.session.activeTabId);
    await Bun.sleep(0);
    expect(started).toHaveLength(1);
    expect(started[0]?.env.API_TOKEN).toBeUndefined();
    await services.env.save({ API_TOKEN: "v2" });
    await Bun.sleep(0);
    expect(started[0]?.kill).toHaveBeenCalledTimes(1);
    expect(started).toHaveLength(2);
    expect(started[1]?.env.API_TOKEN).toBe("v2");
  });

  test("npm and types services are composed; saving env.json recycles spares", async () => {
    const paths = resolveAppPaths({
      resourcesFolder: join(dir, "Resources"),
      userData: dir,
      execPath: process.execPath,
      env: {},
    });
    const started: string[] = [];
    services = await createMainServices({
      paths,
      env: {},
      shiftHeld: Promise.resolve(false),
      realHome: join(dir, "home"),
      onEvents: () => {},
      onState: () => {},
      onDiagnostics: () => {},
      onNpmOperation: () => {},
      onNpmLog: () => {},
      onNpmChanged: () => {},
      startRunner: (config) => {
        started.push(config.cwd);
        return Promise.reject(new Error("no runners in this test"));
      },
      transformHost: { transform: () => Promise.reject(new Error("no transforms")), dispose: () => {} },
    });
    expect((await services.npm.list({ refreshOutdated: false })).installed).toEqual([]);
    expect(await services.types.local(services.session.session.activeTabId, ["./x"])).toEqual({
      files: [],
      packages: [],
      truncated: false,
    });
    services.spares.setActiveTab(services.session.session.activeTabId);
    await Bun.sleep(0);
    const before = started.length;
    await services.env.save({ A: "1" });
    await Bun.sleep(0);
    expect(started.length).toBe(before + 1);
  });
});
