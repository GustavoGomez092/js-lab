import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { type EnvVars, MAX_DOTENV_BYTES, parseDotenv } from "@jslab/shared";
import { type AppPaths, runnerEnvironment } from "../app-paths";
import type { RunnerSpawnConfig } from "./bun-runner-process";

export function isDirectorySync(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** A regular file's text when it is at most `maxBytes`, else null (a missing or oversized .env is ignored). */
function readTextSync(path: string, maxBytes: number): string | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > maxBytes) return null;
    const buffer = Buffer.alloc(info.size);
    readSync(fd, buffer, 0, info.size, 0);
    return buffer.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

export interface RunnerConfigDeps {
  paths: Pick<AppPaths, "bunBinary" | "runnerBootstrap" | "dataDir" | "packagesNodeModules">;
  baseEnv(): Record<string, string | undefined>;
  envVars(): EnvVars;
  workingDirectory(tabId: string): string | null;
  isDirectory?(path: string): boolean;
  readText?(path: string, maxBytes: number): string | null;
}

/**
 * The SparePool's `configFor` (spec §5.3). SparePool.prepare is synchronous, so the WD check and the .env read are
 * synchronous too. The spare key hashes cwd and env, so any WD, env.json or .env change starts a fresh spare.
 */
export function createRunnerConfig(deps: RunnerConfigDeps): (tabId: string) => RunnerSpawnConfig {
  return (tabId) => {
    const requested = deps.workingDirectory(tabId);
    const workingDirectory = requested && (deps.isDirectory ?? isDirectorySync)(requested) ? requested : null;
    const text = workingDirectory
      ? (deps.readText ?? readTextSync)(join(workingDirectory, ".env"), MAX_DOTENV_BYTES)
      : null;
    return {
      bunPath: deps.paths.bunBinary,
      bootstrapPath: deps.paths.runnerBootstrap,
      cwd: workingDirectory ?? deps.paths.dataDir,
      env: runnerEnvironment(deps.paths, {
        base: deps.baseEnv(),
        variables: deps.envVars(),
        dotenv: text === null ? {} : parseDotenv(text),
        workingDirectory,
      }),
    };
  };
}
