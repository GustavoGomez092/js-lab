import { closeSync, constants, fstatSync, openSync, readSync, statSync } from "node:fs";
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

/**
 * A regular file's text when it is at most `maxBytes`, else null (a missing, oversized or non-regular .env is ignored).
 * Opens with O_NONBLOCK (R-M3-T14-FIX-1 I-1): prepare() is synchronous, so a FIFO .env must never block Main waiting
 * for a writer. Reads until EOF or the fstat size (N-2); a short final read returns only the bytes read.
 */
function readTextSync(path: string, maxBytes: number): string | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > maxBytes) return null;
    const buffer = Buffer.alloc(info.size);
    let read = 0;
    while (read < buffer.length) {
      const bytesRead = readSync(fd, buffer, read, buffer.length - read, read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    return buffer.subarray(0, read).toString("utf8");
  } catch {
    return null;
  } finally {
    try {
      closeSync(fd);
    } catch {
      // Closing failed; the result above stands.
    }
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
    const cwd = workingDirectory ?? deps.paths.dataDir;
    const env = runnerEnvironment(deps.paths, {
      base: deps.baseEnv(),
      variables: deps.envVars(),
      dotenv: text === null ? {} : parseDotenv(text),
      workingDirectory,
    });
    // M-2: a runner's PWD always matches its real cwd. PWD follows cwd, so the spare key's behavior is unchanged.
    env.PWD = cwd;
    return { bunPath: deps.paths.bunBinary, bootstrapPath: deps.paths.runnerBootstrap, cwd, env };
  };
}
