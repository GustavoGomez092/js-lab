import { statSync } from "node:fs";
import { join } from "node:path";
import { type EnvVars, MAX_DOTENV_BYTES, parseDotenv } from "@jslab/shared";
import { type AppPaths, runnerEnvironment } from "../app-paths";
import { readBoundedTextSync } from "../files/bounded-read";
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
 *
 * The open/fstat/refuse-before-allocating sequence this used to spell out inline is now `readBoundedTextSync`
 * (`../files/bounded-read.ts`) -- the same algorithm, with the same O_NONBLOCK that keeps a FIFO `.env` from
 * blocking Main (R-M3-T14-FIX-1 I-1) now that `prepare()` is synchronous, and the same short-read handling (N-2).
 * This was the third hand-written copy of that sequence in Main; they now share one, because a check whose *order*
 * is the entire guarantee is exactly the thing that must not exist in three places.
 *
 * The `null` contract is unchanged: every failure, refusal included, means "no `.env` to apply here".
 */
function readTextSync(path: string, maxBytes: number): string | null {
  try {
    return readBoundedTextSync(path, maxBytes);
  } catch {
    return null;
  }
}

/** What computing a run's cwd and environment needs, independently of which runtime is going to use it. */
export interface RunnerEnvironmentDeps {
  paths: Pick<AppPaths, "dataDir" | "packagesNodeModules">;
  baseEnv(): Record<string, string | undefined>;
  envVars(): EnvVars;
  isDirectory?(path: string): boolean;
  readText?(path: string, maxBytes: number): string | null;
}

export interface RunnerConfigDeps extends RunnerEnvironmentDeps {
  paths: Pick<AppPaths, "bunBinary" | "runnerBootstrap" | "dataDir" | "packagesNodeModules">;
  workingDirectory(tabId: string): string | null;
}

/**
 * The cwd and environment one run gets, derived from its working directory alone (spec §5.3).
 *
 * **Both runtimes go through here** (Task 9f items 5 and 6). It used to be inlined in `createRunnerConfig`, which
 * made it the `bun` runtime's private business: `browser-node` separately reported Main's own `process.cwd()` as
 * `process.cwd()` and handed bridged commands Main's raw `process.env`, so the same script saw a different working
 * directory and a different environment depending only on which runtime the tab was set to -- and a working
 * directory's `.env` silently never applied. Extracting it is what makes the parity structural rather than a
 * comment asking two call sites to stay in step.
 *
 * Synchronous, because `SparePool.prepare` is: the WD check and the `.env` read both have to complete inline.
 */
export function runnerContextFor(
  deps: RunnerEnvironmentDeps,
  requested: string | null,
): { cwd: string; env: Record<string, string> } {
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
  return { cwd, env };
}

/**
 * The SparePool's `configFor` (spec §5.3). The spare key hashes cwd and env, so any WD, env.json or .env change
 * starts a fresh spare.
 */
export function createRunnerConfig(deps: RunnerConfigDeps): (tabId: string) => RunnerSpawnConfig {
  return (tabId) => {
    const { cwd, env } = runnerContextFor(deps, deps.workingDirectory(tabId));
    return { bunPath: deps.paths.bunBinary, bootstrapPath: deps.paths.runnerBootstrap, cwd, env };
  };
}
