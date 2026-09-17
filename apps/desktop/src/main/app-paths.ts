import { join } from "node:path";
import type { EnvVars } from "@jslab/shared";

export interface AppPathsInput {
  /** Electrobun `PATHS.RESOURCES_FOLDER` (the bundle's Resources folder). */
  resourcesFolder: string;
  /** Electrobun `Utils.paths.userData`, laid out as `<appData>/dev.jslab.app/<channel>` (spec §4.5). */
  userData: string;
  /** `process.execPath` of the main process: the Bun binary bundled by Electrobun. */
  execPath: string;
  env: Record<string, string | undefined>;
}

export interface AppPaths {
  dataDir: string;
  runsDir: string;
  runLock: string;
  packagesNodeModules: string;
  packagesDir: string;
  packagesJson: string;
  packagesNpmrc: string;
  /** The empty HOME of npm operations (spec §11.3, M0-S8). */
  npmHome: string;
  /** The web runner's third-party chunk cache (spec §5.12): `apps/desktop/src/main/bundling/vendor-cache.ts`. */
  vendorCacheDir: string;
  envFile: string;
  socketPath: string;
  screenshotsDir: string;
  runnerBootstrap: string;
  /**
   * M4 §5.12: the bundled runner-web bootstrap Main injects into a browser-mode tab's page. The page itself is
   * bare (no `<script>`), so this string is the only thing that turns it into a runner.
   */
  webRunnerBootstrap: string;
  transformWorker: string;
  /**
   * Spec §17: the locale files Main reads. They are authored at `apps/ui/src/i18n/locales/` -- the path the
   * spec names -- and staged into the bundle by hutch.config.ts's `build:bundles`, exactly as
   * THIRD-PARTY-NOTICES.md is. Main reads them at runtime rather than inlining them at build time, so it
   * really does read the same files the UI ships.
   */
  localesDir: string;
  bunBinary: string;
}

/**
 * Every filesystem location Main uses. Bundled scripts are copied by `electrobun.config.ts` into
 * `Resources/app/{runner,workers}`; env overrides let tests and `hutch electrobun dev` point at sources.
 * If the M0-S1/S3 report records a different copy destination, change only this function.
 */
export function resolveAppPaths(input: AppPathsInput): AppPaths {
  const appDir = join(input.resourcesFolder, "app");
  // JSLAB_USER_DATA points a launch at a separate data folder (E2E runs, manual QA). Runners never see it,
  // because runnerEnvironment drops every JSLAB_* variable.
  const dataDir = input.env.JSLAB_USER_DATA ?? input.userData;
  return {
    dataDir,
    runsDir: join(dataDir, "runs"),
    runLock: join(dataDir, "run.lock"),
    packagesNodeModules: join(dataDir, "packages", "node_modules"),
    packagesDir: join(dataDir, "packages"),
    packagesJson: join(dataDir, "packages", "package.json"),
    packagesNpmrc: join(dataDir, "packages", ".npmrc"),
    npmHome: join(dataDir, "npm-home"),
    vendorCacheDir: join(dataDir, "cache", "vendor"),
    envFile: join(dataDir, "env.json"),
    socketPath: join(dataDir, "jslab.sock"),
    screenshotsDir: join(dataDir, "e2e-screenshots"),
    runnerBootstrap: input.env.JSLAB_RUNNER_BOOTSTRAP ?? join(appDir, "runner", "bootstrap.js"),
    webRunnerBootstrap: input.env.JSLAB_WEB_RUNNER_BOOTSTRAP ?? join(appDir, "runner", "web-bootstrap.js"),
    transformWorker: input.env.JSLAB_TRANSFORM_WORKER ?? join(appDir, "workers", "transform-worker.js"),
    localesDir: input.env.JSLAB_LOCALES_DIR ?? join(appDir, "locales"),
    bunBinary: input.env.JSLAB_BUN_PATH ?? input.execPath,
  };
}

/** Under E2E, npm uses a private Bun cache: JSLAB_E2E_BUN_CACHE_DIR, else <dataDir>/e2e-bun-cache. Never the user's cache. */
export function e2eBunCacheDir(env: Record<string, string | undefined>, dataDir: string): string | undefined {
  if (env.JSLAB_E2E !== "1") return undefined;
  return env.JSLAB_E2E_BUN_CACHE_DIR ? env.JSLAB_E2E_BUN_CACHE_DIR : join(dataDir, "e2e-bun-cache");
}

export interface RunnerEnvironmentInput {
  /** The login-shell environment (spec §4.6). */
  base: Record<string, string | undefined>;
  /** env.json (spec §12.1). */
  variables?: EnvVars;
  /** The WD's .env, parsed by JSLab (spec §5.3). */
  dotenv?: Record<string, string>;
  workingDirectory?: string | null;
}

/**
 * Keys no layer may set in a runner's environment: JSLab's own, BUN_OPTIONS, and names that would corrupt `environ`
 * (an empty key, or one containing = or NUL, e.g. "BUN_OPTIONS=--preload"; R-M3-T14-FIX-2 NEW-N4).
 */
function isReservedRunnerKey(key: string): boolean {
  if (key === "" || key.includes("=") || key.includes(String.fromCharCode(0))) return true;
  // R-M3-T14-BUNOPTS-1: JSLab owns the runner's Bun flags; BUN_OPTIONS could add --preload or --env-file.
  return key.startsWith("JSLAB_") || key === "BUN_OPTIONS";
}

/**
 * Environment for runner processes (spec §5.3): login shell → env.json → the WD's .env → JSLAB=1, later layers winning.
 * JSLAB_* keys never reach a runner, and JSLab always sets NODE_PATH: the WD's node_modules first, then app packages.
 */
export function runnerEnvironment(
  paths: Pick<AppPaths, "packagesNodeModules">,
  input: RunnerEnvironmentInput,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.base)) {
    if (value !== undefined && !isReservedRunnerKey(key)) env[key] = value;
  }
  for (const layer of [input.variables ?? {}, input.dotenv ?? {}]) {
    for (const [key, value] of Object.entries(layer)) if (!isReservedRunnerKey(key)) env[key] = value;
  }
  env.JSLAB = "1";
  env.NODE_PATH = input.workingDirectory
    ? `${join(input.workingDirectory, "node_modules")}:${paths.packagesNodeModules}`
    : paths.packagesNodeModules;
  return env;
}
