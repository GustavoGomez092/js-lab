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
  return {
    dataDir: input.userData,
    runsDir: join(input.userData, "runs"),
    runLock: join(input.userData, "run.lock"),
    packagesNodeModules: join(input.userData, "packages", "node_modules"),
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
