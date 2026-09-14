import { runnerSettings } from "@jslab/shared";
import { type AppPaths, runnerEnvironment } from "./app-paths";
import { RunLock } from "./persistence/run-lock";
import { BunRunnerProcess, type RunnerSpawnConfig } from "./runs/bun-runner-process";
import { RunCoordinator, type RunCoordinatorDeps } from "./runs/run-coordinator";
import { SparePool } from "./runs/spare-pool";
import { detectSafeMode, type SafeModeState } from "./services/safe-mode";
import { SessionStore } from "./services/session-store";
import { SettingsStore } from "./services/settings-store";
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
}

export interface MainServices {
  settings: SettingsStore;
  session: SessionStore;
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
  const runLock = new RunLock(paths.runLock);
  const [settings, session] = await Promise.all([SettingsStore.open(paths.dataDir), SessionStore.open(paths.dataDir)]);
  const safeMode = await detectSafeMode({
    uncleanPreviousExit: runLock.uncleanPreviousExit,
    shiftHeld: () => options.shiftHeld,
  });
  const transform = options.transformHost ?? new CachingTransformHost(new WorkerTransformHost(paths.transformWorker));
  const spares = new SparePool(options.startRunner ?? ((config) => BunRunnerProcess.start(config)), () => ({
    bunPath: paths.bunBinary,
    bootstrapPath: paths.runnerBootstrap,
    cwd: paths.dataDir,
    env: runnerEnvironment(paths, options.env),
  }));
  const coordinator = new RunCoordinator({
    transform: (source, transformOptions) => transform.transform(source, transformOptions),
    spares,
    runsDir: paths.runsDir,
    settings: () => runnerSettings(settings.current),
    onEvents: options.onEvents,
    onState: options.onState,
    onDiagnostics: options.onDiagnostics,
    runLock,
  });
  return {
    settings,
    session,
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
