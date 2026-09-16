import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NpmListResult } from "@jslab/rpc-schema";
import { resolveAppPaths } from "../src/main/app-paths";
import { createMainServices, type MainServices } from "../src/main/main-services";
import { createRpcHandlers, InvalidPayloadError } from "../src/main/rpc-handlers";
import type { BunRunnerProcess, RunnerSpawnConfig } from "../src/main/runs/bun-runner-process";
import type { NpmSpawnOptions } from "../src/main/services/npm-spawn";

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

  test("an npm change through the injected spawn recycles spares, clears types, reports npm.changed and uses the cache override", async () => {
    const paths = resolveAppPaths({
      resourcesFolder: join(dir, "Resources"),
      userData: dir,
      execPath: process.execPath,
      env: {},
    });
    const started: string[] = [];
    const spawned: { argv: readonly string[]; options: NpmSpawnOptions }[] = [];
    const fetched: string[] = [];
    const changed: NpmListResult[] = [];
    let reportChanged: () => void = () => {};
    const changedOnce = new Promise<void>((resolve) => {
      reportChanged = resolve;
    });
    services = await createMainServices({
      paths,
      env: {},
      shiftHeld: Promise.resolve(false),
      realHome: join(dir, "home"),
      bunCacheDirOverride: join(dir, "bun-cache"),
      // R-M3-T18-NET-1: every npm step is answered here, and any fetch is recorded and refused.
      npmSpawn: async (argv, options) => {
        spawned.push({ argv, options });
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      npmFetch: (async (input: unknown) => {
        fetched.push(String(input));
        throw new Error("no network in this test");
      }) as unknown as typeof fetch,
      onEvents: () => {},
      onState: () => {},
      onDiagnostics: () => {},
      onNpmOperation: () => {},
      onNpmLog: () => {},
      onNpmChanged: (list) => {
        changed.push(list);
        reportChanged();
      },
      startRunner: (config) => {
        started.push(config.cwd);
        return Promise.reject(new Error("no runners in this test"));
      },
      transformHost: { transform: () => Promise.reject(new Error("no transforms")), dispose: () => {} },
    });
    expect(services.settings.current.npm.autoInstallTypes).toBe(false);
    const typesInvalidate = spyOn(services.types, "invalidate");
    services.spares.setActiveTab(services.session.session.activeTabId);
    const before = started.length;
    expect(before).toBe(1);
    services.npm.remove("left-pad");
    await changedOnce;
    await services.npm.whenIdle();
    expect(started.length).toBe(before + 1);
    expect(typesInvalidate).toHaveBeenCalledTimes(1);
    expect(changed).toHaveLength(1);
    expect(spawned.map((entry) => entry.argv)).toEqual([["remove", "left-pad"]]);
    for (const { options } of spawned) expect(options.env.BUN_INSTALL_CACHE_DIR).toBe(join(dir, "bun-cache"));
    expect(fetched).toEqual([]);
  });
});
