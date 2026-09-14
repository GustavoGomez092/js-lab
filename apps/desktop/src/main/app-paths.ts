import { join } from "node:path";

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
  envFile: string;
  socketPath: string;
  screenshotsDir: string;
  runnerBootstrap: string;
  transformWorker: string;
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
    envFile: join(dataDir, "env.json"),
    socketPath: join(dataDir, "jslab.sock"),
    screenshotsDir: join(dataDir, "e2e-screenshots"),
    runnerBootstrap: input.env.JSLAB_RUNNER_BOOTSTRAP ?? join(appDir, "runner", "bootstrap.js"),
    transformWorker: input.env.JSLAB_TRANSFORM_WORKER ?? join(appDir, "workers", "transform-worker.js"),
    bunBinary: input.env.JSLAB_BUN_PATH ?? input.execPath,
  };
}

/** Environment for runner processes (spec §5.3). The login-shell environment and `.env` loading arrive in M3. */
export function runnerEnvironment(paths: AppPaths, base: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && !key.startsWith("JSLAB_")) env[key] = value;
  }
  env.JSLAB = "1";
  env.NODE_PATH = paths.packagesNodeModules;
  return env;
}
