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
import { WELCOME_CODE, WELCOME_TITLE } from "../src/main/welcome";

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
  /** Boots the services a first launch would get, with `env` standing in for the process environment. */
  const bootstrapWith = async (env: Record<string, string | undefined>) => {
    const paths = resolveAppPaths({
      resourcesFolder: join(dir, "Resources"),
      userData: dir,
      execPath: process.execPath,
      env: {},
    });
    services = await createMainServices({
      paths,
      env,
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
    const [onlyId] = services.session.session.tabOrder;
    if (!onlyId) throw new Error("expected one tab");
    return { tab: services.session.session.tabs[onlyId], buffer: await services.session.readBuffer(onlyId) };
  };

  /**
   * R-M5a-REGRESSION-1. `dir` is a fresh mkdtemp, so each of these is a genuinely first launch -- and so is every
   * E2E launch, because the harness hands each one a brand new data folder. Three scenarios broke when the welcome
   * tab began rewriting that first tab's title, language and content, so the harness gets the plain empty tab it
   * has always assumed unless a scenario asks for the sample by name.
   */
  test("the welcome tab is suppressed under the E2E harness, and opted back into with JSLAB_E2E_WELCOME", async () => {
    const suppressed = await bootstrapWith({ JSLAB_E2E: "1" });
    expect(suppressed.buffer).toBe("");
    expect(suppressed.tab).toMatchObject({ titleIsCustom: false, pristine: false });

    // A second genuinely first launch: the opt-in is what brings the sample back, nothing else about the folder.
    services?.dispose();
    services = null;
    await rm(join(dir, "session.json"), { force: true });
    await rm(join(dir, "session.json.bak"), { force: true });

    const optedIn = await bootstrapWith({ JSLAB_E2E: "1", JSLAB_E2E_WELCOME: "1" });
    expect(optedIn.buffer).toBe(WELCOME_CODE);
    expect(optedIn.tab).toMatchObject({ title: WELCOME_TITLE, titleIsCustom: true, language: "tsx", pristine: true });
  });

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
    // Task 10 (spec §7.5): this test's `dir` is a fresh mkdtemp, so it is a genuinely first launch. This is the
    // only place that proves the composition root actually hands SessionStore the welcome tab -- session-store's
    // own tests pass `firstRun` themselves and so cannot catch main-services.ts forgetting to.
    expect(payload.buffers).toEqual({ [payload.session.activeTabId]: WELCOME_CODE });
    expect(payload.session.tabs[payload.session.activeTabId]).toMatchObject({
      title: WELCOME_TITLE,
      titleIsCustom: true,
      language: "tsx",
    });
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

  test("an npm change through the injected spawn recycles spares, clears types, drops the vendor cache, reports npm.changed and uses the cache override", async () => {
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
    // M4/spec §11.3: the vendor cache's own wipe joins the same npm-change path as types and spares below.
    const vendorCacheInvalidateAll = spyOn(services.vendorCache, "invalidateAll");
    services.spares.setActiveTab(services.session.session.activeTabId);
    const before = started.length;
    expect(before).toBe(1);
    services.npm.remove("left-pad");
    await changedOnce;
    await services.npm.whenIdle();
    expect(started.length).toBe(before + 1);
    expect(typesInvalidate).toHaveBeenCalledTimes(1);
    expect(vendorCacheInvalidateAll).toHaveBeenCalledTimes(1);
    expect(changed).toHaveLength(1);
    expect(spawned.map((entry) => entry.argv)).toEqual([["remove", "left-pad"]]);
    for (const { options } of spawned) expect(options.env.BUN_INSTALL_CACHE_DIR).toBe(join(dir, "bun-cache"));
    expect(fetched).toEqual([]);
  });
});
