import { join } from "node:path";
import type { NpmListResult, NpmOperation } from "@jslab/rpc-schema";
import { effectiveRuntime, runnerSettings } from "@jslab/shared";
import type { AppPaths } from "./app-paths";
import { RunLock } from "./persistence/run-lock";
import { BunRunnerProcess, type RunnerSpawnConfig } from "./runs/bun-runner-process";
import { EXIT_KILL_GRACE_MS, RunCoordinator, type RunCoordinatorDeps } from "./runs/run-coordinator";
import { createRunnerConfig } from "./runs/runner-config";
import { SparePool } from "./runs/spare-pool";
import { createBunAdapter } from "./runtimes/bun-adapter";
import { createRuntimeRegistry } from "./runtimes/registry";
import { EnvStore } from "./services/env-store";
import { NpmService } from "./services/npm-service";
import { createBunSpawn, type NpmSpawn } from "./services/npm-spawn";
import { ensurePackagesProject } from "./services/packages-project";
import { consumeSafeModeFlag, detectSafeMode, type SafeModeState } from "./services/safe-mode";
import { SessionStore } from "./services/session-store";
import { SettingsStore } from "./services/settings-store";
import { TypesService } from "./services/types-service";
import { strings } from "./strings";
import { CachingTransformHost, type TransformHost, WorkerTransformHost } from "./transform/transform-host";

export interface MainServicesOptions {
  paths: AppPaths;
  env: Record<string, string | undefined>;
  /** Started by the caller before anything else: the user may release Shift while the stores load. */
  shiftHeld: Promise<boolean>;
  /** Where run output leaves Main; `index.ts` forwards these over the Electrobun RPC. */
  onEvents: RunCoordinatorDeps["onEvents"];
  onState: RunCoordinatorDeps["onState"];
  onDiagnostics: RunCoordinatorDeps["onDiagnostics"];
  /** Test seams. Production spawns real Bun runners and runs Babel in the bundled transform worker. */
  startRunner?: (config: RunnerSpawnConfig) => Promise<BunRunnerProcess>;
  transformHost?: TransformHost;
  /** Main's log (index.ts passes the rotating log). Defaults to console.error. */
  log?: (message: string, detail?: unknown) => void;
  /** The user's real home folder (for the Bun cache location, spec §11.3). */
  realHome: string;
  /** E2E only: a temp Bun cache for npm operations instead of the user's. */
  bunCacheDirOverride?: string;
  npmSpawn?: NpmSpawn;
  npmFetch?: typeof fetch;
  onNpmOperation(operation: NpmOperation): void;
  onNpmLog(opId: string, text: string): void;
  onNpmChanged(list: NpmListResult): void;
}

export interface MainServices {
  settings: SettingsStore;
  session: SessionStore;
  env: EnvStore;
  npm: NpmService;
  types: TypesService;
  runLock: RunLock;
  safeMode: SafeModeState;
  transform: TransformHost;
  spares: SparePool;
  coordinator: RunCoordinator;
  /** Disposes runners, the watchdog and the transform worker, and releases run.lock. */
  dispose(): void;
}

/**
 * The composition root (M1 final review, M2-readiness note 4): everything Main needs that doesn't touch Electrobun.
 * `start()` in index.ts adds the window, menu, RPC and socket around it; tests build it against a temporary folder.
 */
export async function createMainServices(options: MainServicesOptions): Promise<MainServices> {
  const { paths } = options;
  const log = options.log ?? ((message: string, detail?: unknown) => console.error(`[jslab] ${message}`, detail ?? ""));
  const runLock = new RunLock(paths.runLock);
  const settings = await SettingsStore.open(paths.dataDir, {
    onWriteError: (error) => log(strings.log.settingsWriteFailed, String(error)),
  });
  const session = await SessionStore.open(paths.dataDir, {
    tabDefaults: () => ({
      language: settings.current.run.defaultLanguage,
      runtime: effectiveRuntime(settings.current.run.defaultRuntime),
      layout: { orientation: settings.current.view.layout, editorSize: 55, outputVisible: true },
    }),
  });
  await ensurePackagesProject(paths, log);
  const env = await EnvStore.open(paths.envFile);
  const safeMode = await detectSafeMode({
    uncleanPreviousExit: runLock.uncleanPreviousExit,
    manualRequested: consumeSafeModeFlag(paths.dataDir),
    shiftHeld: () => options.shiftHeld,
  });
  const transform = options.transformHost ?? new CachingTransformHost(new WorkerTransformHost(paths.transformWorker));
  const spares = new SparePool(
    options.startRunner ?? ((config) => BunRunnerProcess.start(config)),
    createRunnerConfig({
      paths,
      baseEnv: () => options.env,
      envVars: () => env.variables,
      workingDirectory: (tabId) => session.session.tabs[tabId]?.workingDirectory ?? null,
    }),
  );
  // The runtime registry (spec §5.1): only "bun" is real until Task 7 registers a "web" adapter here too.
  const runtimes = createRuntimeRegistry({
    bun: createBunAdapter({ spares, runsDir: paths.runsDir, runLock, exitGraceMs: EXIT_KILL_GRACE_MS }),
  });
  const coordinator = new RunCoordinator({
    transform: (source, transformOptions) => transform.transform(source, transformOptions),
    spares,
    runsDir: paths.runsDir,
    settings: () => runnerSettings(settings.current),
    onEvents: options.onEvents,
    onState: options.onState,
    onDiagnostics: options.onDiagnostics,
    runLock,
    runtimes,
  });
  // Spec §12.1: saving env.json recycles every tab's spare, so the next run gets the new values.
  env.onChange(() => spares.invalidateAll());
  const workingDirectoryFor = (tabId: string) => session.session.tabs[tabId]?.workingDirectory ?? null;
  const types = new TypesService({
    workingDirectoryFor,
    nodeModulesDirsFor: (tabId) => {
      const workingDirectory = workingDirectoryFor(tabId);
      return workingDirectory
        ? [join(workingDirectory, "node_modules"), paths.packagesNodeModules]
        : [paths.packagesNodeModules];
    },
  });
  const npm = new NpmService({
    paths,
    baseEnv: () => options.env,
    realHome: options.realHome,
    ...(options.bunCacheDirOverride ? { cacheDirOverride: options.bunCacheDirOverride } : {}),
    settings: () => settings.current.npm,
    spawn: options.npmSpawn ?? createBunSpawn(paths.bunBinary),
    ...(options.npmFetch ? { fetch: options.npmFetch } : {}),
    onOperation: options.onNpmOperation,
    onLog: options.onNpmLog,
    onChanged: options.onNpmChanged,
    // Spec §11.3: after any change, spares are recycled and the type cache is invalidated (web vendor caches: M4).
    afterChange: () => {
      spares.invalidateAll();
      types.invalidate();
    },
    log,
  });
  return {
    settings,
    session,
    env,
    npm,
    types,
    runLock,
    safeMode,
    transform,
    spares,
    coordinator,
    dispose() {
      coordinator.dispose();
      transform.dispose();
      runLock.releaseAll();
    },
  };
}
