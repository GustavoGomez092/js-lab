import { join } from "node:path";
import type { NpmListResult, NpmOperation, StartupNotice } from "@jslab/rpc-schema";
import { effectiveRuntime, runnerSettings } from "@jslab/shared";
import type { AppPaths } from "./app-paths";
import { VendorCache } from "./bundling/vendor-cache";
import { type FileTooLargeError, readRegularFileText } from "./fs/bounded-read";
import { RunLock } from "./persistence/run-lock";
import { BunRunnerProcess, type RunnerSpawnConfig } from "./runs/bun-runner-process";
import { EXIT_KILL_GRACE_MS, RunCoordinator, type RunCoordinatorDeps } from "./runs/run-coordinator";
import { createRunnerConfig, runnerContextFor } from "./runs/runner-config";
import { SparePool } from "./runs/spare-pool";
import { createBunAdapter } from "./runtimes/bun-adapter";
import { createRuntimeRegistry, type RuntimeRegistry } from "./runtimes/registry";
import { createWebAdapter, type WebAdapterDeps } from "./runtimes/web-adapter";
import { createUiWebviewSource, type UiWebviewSource, type WebviewBridge } from "./runtimes/webview-source";
import { EnvStore } from "./services/env-store";
import { NpmService } from "./services/npm-service";
import { createBunSpawn, type NpmSpawn } from "./services/npm-spawn";
import { ensurePackagesProject } from "./services/packages-project";
import { consumeSafeModeFlag, detectSafeMode, type SafeModeState } from "./services/safe-mode";
import { SessionStore } from "./services/session-store";
import { SettingsStore } from "./services/settings-store";
import { SnippetStore } from "./services/snippet-store";
import { TypesService } from "./services/types-service";
import { strings } from "./strings";
import { CachingTransformHost, type TransformHost, WorkerTransformHost } from "./transform/transform-host";
import { WELCOME_CODE, WELCOME_TITLE } from "./welcome";

export interface MainServicesOptions {
  paths: AppPaths;
  env: Record<string, string | undefined>;
  /** Started by the caller before anything else: the user may release Shift while the stores load. */
  shiftHeld: Promise<boolean>;
  /** Where run output leaves Main; `index.ts` forwards these over the Electrobun RPC. */
  onEvents: RunCoordinatorDeps["onEvents"];
  onState: RunCoordinatorDeps["onState"];
  onDiagnostics: RunCoordinatorDeps["onDiagnostics"];
  /** Task 15 (spec §5.12, EX-35). Optional, like `RunCoordinatorDeps.onAudio` itself. */
  onAudio?: RunCoordinatorDeps["onAudio"];
  /** Test seams. Production spawns real Bun runners and runs Babel in the bundled transform worker. */
  startRunner?: (config: RunnerSpawnConfig) => Promise<BunRunnerProcess>;
  transformHost?: TransformHost;
  /**
   * Bun adapter timing knobs (spec §5.1). Undefined in production, which leaves every one at its documented
   * default; a caller that does set one gets it applied identically whether or not `RunCoordinator` ends up using
   * its own fallback registry or the `runtimes` one built below (fix round 1, Finding 3).
   */
  stopGraceMs?: RunCoordinatorDeps["stopGraceMs"];
  idleRunnerTtlMs?: RunCoordinatorDeps["idleRunnerTtlMs"];
  expandTimeoutMs?: RunCoordinatorDeps["expandTimeoutMs"];
  /** Main's log (index.ts passes the rotating log). Defaults to console.error. */
  log?: (message: string, detail?: unknown) => void;
  /**
   * How Main tells the USER something after startup (`app.notice`). `index.ts` binds this to the main window's RPC
   * once that window exists; it defaults to a sender that delivers nothing, which is what headless tests get.
   *
   * D1: raised for a settings write refused as too large. That refusal is the one write failure the user cannot
   * otherwise discover -- `update()` still resolves, the RPC still reports success, the UI still shows the change,
   * and the only trace is a line in the rotating log. Logging it is not telling them.
   *
   * Returns whether the notice actually REACHED the user. Before the main window exists there is nowhere to show
   * one, and a caller that rations its telling has to tell that apart from having told them -- see the latch on
   * `toldSettingsTooLarge` below, which is the bug this return value exists to prevent.
   */
  notify?: (notice: StartupNotice) => boolean;
  /**
   * Fix round 1 (Task 13, security): masks anything recorded about a `browser-node` fetch (spec §18) before it
   * reaches the log or the page. `index.ts` passes its own `redact`; defaults to a no-op so tests that never touch
   * `browser-node` fetch don't need to supply one.
   */
  redact?: (text: string) => string;
  /** The user's real home folder (for the Bun cache location, spec §11.3). */
  realHome: string;
  /** E2E only: a temp Bun cache for npm operations instead of the user's. */
  bunCacheDirOverride?: string;
  /**
   * M4 §5.12: how Main reaches the UI's `<electrobun-webview>` elements. `index.ts` provides it (it owns the main
   * window's RPC); headless tests don't, and there is nothing a web adapter could drive without one -- so
   * `browser`/`browser-node` then keep the documented Bun fallback rather than registering a runtime whose every
   * run could only time out. That is the same trade Task 9 made when it declined to register a stub.
   */
  webviewBridge?: WebviewBridge;
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
  /** Spec §13.4: the snippet library. */
  snippets: SnippetStore;
  npm: NpmService;
  types: TypesService;
  runLock: RunLock;
  safeMode: SafeModeState;
  transform: TransformHost;
  spares: SparePool;
  /** M4: the web runner's third-party chunk cache (spec §5.12); invalidated by `npm.afterChange` below (§11.3). */
  vendorCache: VendorCache;
  /** The runtime → adapter lookup (spec §5.1), exposed so callers can see what actually got registered. */
  runtimes: RuntimeRegistry;
  /**
   * M4 §5.12: Main's side of the browser runtimes' webviews -- where `index.ts` routes the UI's `webRunner.*`
   * messages. Null when no `webviewBridge` was provided, which is also when no web adapter is registered.
   */
  webviews: UiWebviewSource | null;
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
  const notify = options.notify ?? (() => false);
  // D1: the refusal recurs on every later settings change, so the telling must not -- once per session. The UI's
  // own `addNotice` also dedupes by id, but leaning on that would make a Main-side flood invisible rather than
  // absent, and would tie a Main guarantee to a UI implementation detail.
  //
  // The latch is on DELIVERY, never on the attempt, and that distinction is the whole of D1/D3. `SettingsStore.open`
  // below rewrites settings.json when the file was recovered or is being migrated -- inside this function, before
  // `index.ts` has a window or an RPC to show anything with. Latching on the attempt spent the single telling on a
  // notice nobody could see: a user upgrading across a SETTINGS_VERSION bump with a near-cap settings.json then had
  // every later settings change fail silently, with no banner ever. The flag has to mean what its name says, "the
  // user has been told", not "we tried".
  let toldSettingsTooLarge = false;
  const settings = await SettingsStore.open(paths.dataDir, {
    onWriteError: (error) => {
      log(strings.log.settingsWriteFailed, String(error));
      // Only the too-large refusal is silent AND permanent; an ordinary write error is transient, and the next
      // change may well succeed, so it stays a log line. `code` is how bounded-read's refusals are told apart
      // everywhere else in Main.
      if ((error as NodeJS.ErrnoException).code !== "EFBIG" || toldSettingsTooLarge) return;
      const refusal = error as FileTooLargeError;
      toldSettingsTooLarge = notify({
        id: "settingsTooLarge",
        message: strings.notices.settingsTooLarge(refusal.size, refusal.maxBytes),
      });
    },
  });
  // R-M5a-REGRESSION-1: the welcome tab rewrites the single tab a fresh profile starts with -- its title, language
  // and content -- and that first tab is the starting state most E2E scenarios assume. Every harness launch gets a
  // brand new data folder, so every one of them is a first launch. Suppress the sample under the harness; a scenario
  // that is *about* the welcome tab opts back in with JSLAB_E2E_WELCOME=1.
  const welcomeSuppressed = options.env.JSLAB_E2E === "1" && options.env.JSLAB_E2E_WELCOME !== "1";
  const session = await SessionStore.open(paths.dataDir, {
    ...(welcomeSuppressed ? {} : { firstRun: { title: WELCOME_TITLE, content: WELCOME_CODE, language: "tsx" } }),
    tabDefaults: () => ({
      language: settings.current.run.defaultLanguage,
      runtime: effectiveRuntime(settings.current.run.defaultRuntime),
      layout: {
        orientation: settings.current.view.layout,
        editorSize: 55,
        outputVisible: true,
        // M4 Task 8: matches tabTilesSchema's own `.catch()` defaults (packages/shared/src/session.ts).
        tiles: { webviewVisible: false, consoleSize: 55 },
        // Task 15: matches tabLayoutSchema's own `.catch()` default for `muted`.
        muted: false,
      },
    }),
  });
  await ensurePackagesProject(paths, log);
  const env = await EnvStore.open(paths.envFile);
  const snippets = await SnippetStore.open(paths.snippetsFile);
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
  const vendorCache = new VendorCache({ cacheDir: paths.vendorCacheDir });
  // M4 Task 9a (ledger ruling R-M4-C1-1): the runtime registry (spec §5.1), now with the browser runtimes really
  // registered. Before this, `createWebAdapter` was fully built and unit-tested but constructed nowhere, so
  // `registry.get("browser")` fell through to the Bun adapter and a tab the user had explicitly set to Browser ran
  // its code under Bun, where `document` doesn't exist. What was missing was never the adapter: it was a real
  // `WebviewSource` to build one from, which needs a live `<electrobun-webview>` (Task 8) *and* a Main⇄UI protocol
  // to drive it (this task) -- see `./runtimes/webview-source.ts`.
  const webviews = options.webviewBridge
    ? createUiWebviewSource({
        bridge: options.webviewBridge,
        // A shipped asset, but inside an app bundle the user can write to, and JSLAB_WEB_RUNNER_BOOTSTRAP can
        // point it anywhere. Its size is whatever the build produced, so the cap is waived; a FIFO at the path is
        // refused rather than hanging the first browser-mode run forever.
        readBootstrap: () => readRegularFileText(paths.webRunnerBootstrap),
      })
    : null;
  // Both web runtimes share the one source: a tab's runtime is fixed when the tab is created, so two adapters can
  // never contend over the same tab's webview.
  const webAdapterDeps = (runtime: "browser" | "browser-node", source: UiWebviewSource): WebAdapterDeps => ({
    webviews: source,
    runtime,
    runsDir: paths.runsDir,
    // Task 11: what a `browser-node` Node call resolves a relative path against when the tab has no working
    // directory -- the same `workingDirectory ?? dataDir` the Bun runner uses (`./runs/runner-config.ts`).
    dataDir: paths.dataDir,
    // Task 9f item 6: what a bridged `child_process` command's environment defaults to. Built through the *same*
    // `runnerContextFor` the Bun runner's own `configFor` uses, so env.json, the working directory's `.env` and the
    // JSLAB_*/BUN_OPTIONS stripping all apply identically whichever runtime the tab happens to be set to -- rather
    // than the bridge handing the child Main's raw `process.env`, under which a user's `.env` never applied at all.
    nodeEnvironment: (workingDirectory) =>
      runnerContextFor({ paths, baseEnv: () => options.env, envVars: () => env.variables }, workingDirectory).env,
    packagesNodeModules: paths.packagesNodeModules,
    bunLockPath: join(paths.packagesDir, "bun.lock"),
    vendorCache,
    runLock,
    log,
    ...(options.redact ? { redact: options.redact } : {}),
    ...(options.stopGraceMs === undefined ? {} : { stopGraceMs: options.stopGraceMs }),
    ...(options.expandTimeoutMs === undefined ? {} : { expandTimeoutMs: options.expandTimeoutMs }),
  });
  const runtimes = createRuntimeRegistry(
    {
      bun: createBunAdapter({
        spares,
        runsDir: paths.runsDir,
        runLock,
        exitGraceMs: EXIT_KILL_GRACE_MS,
        stopGraceMs: options.stopGraceMs,
        idleRunnerTtlMs: options.idleRunnerTtlMs,
        expandTimeoutMs: options.expandTimeoutMs,
      }),
      ...(webviews
        ? {
            browser: createWebAdapter(webAdapterDeps("browser", webviews)),
            "browser-node": createWebAdapter(webAdapterDeps("browser-node", webviews)),
          }
        : {}),
    },
    log,
  );
  const coordinator = new RunCoordinator({
    transform: (source, transformOptions) => transform.transform(source, transformOptions),
    spares,
    runsDir: paths.runsDir,
    settings: () => runnerSettings(settings.current),
    onEvents: options.onEvents,
    onState: options.onState,
    onDiagnostics: options.onDiagnostics,
    onAudio: options.onAudio,
    runLock,
    stopGraceMs: options.stopGraceMs,
    idleRunnerTtlMs: options.idleRunnerTtlMs,
    expandTimeoutMs: options.expandTimeoutMs,
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
    // Spec §11.3: after any change, spares are recycled, the type cache is invalidated, and (M4) every cached web
    // runner vendor chunk is dropped -- not just the ones whose key happens to go stale, since a chunk not yet
    // rebuilt under its new key would otherwise linger on disk.
    afterChange: () => {
      spares.invalidateAll();
      types.invalidate();
      vendorCache.invalidateAll().catch((error) => log(strings.log.vendorCacheInvalidateFailed, String(error)));
    },
    log,
  });
  return {
    settings,
    session,
    env,
    snippets,
    npm,
    types,
    runLock,
    safeMode,
    transform,
    spares,
    vendorCache,
    runtimes,
    webviews,
    coordinator,
    dispose() {
      coordinator.dispose();
      transform.dispose();
      runLock.releaseAll();
    },
  };
}
