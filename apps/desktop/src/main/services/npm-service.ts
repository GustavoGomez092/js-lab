import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  classifyNpmFailure,
  detectNotice,
  npmEnvironment,
  OperationQueue,
  OperationTimeoutError,
  parseInstallSpec,
  resolveBunCacheDir,
} from "@jslab/npm";
import type { InstalledPackage, NpmListResult, NpmOperation, NpmOpKind } from "@jslab/rpc-schema";
import { defaultPackagesManifest, type PackagesManifest } from "@jslab/shared";
import type { AppPaths } from "../app-paths";
import { writeFileAtomic } from "../persistence/atomic-write";
import { strings } from "../strings";
import type { NpmSpawn, NpmSpawnResult } from "./npm-spawn";

export type NpmPaths = Pick<
  AppPaths,
  "packagesDir" | "packagesJson" | "packagesNpmrc" | "npmHome" | "packagesNodeModules"
>;

export interface NpmServiceDeps {
  paths: NpmPaths;
  /** The login-shell environment (Task 14). npm operations derive their isolated environment from it (M0-S8). */
  baseEnv(): Record<string, string | undefined>;
  /** The user's real home folder, read before any override (used by resolveBunCacheDir). */
  realHome: string;
  /** Tests and E2E: a temp cache instead of the user's Bun cache. Production leaves it undefined. */
  cacheDirOverride?: string;
  settings(): { allowInstallScripts: boolean; autoInstallTypes: boolean };
  spawn: NpmSpawn;
  fetch?: typeof fetch;
  queue?: OperationQueue;
  now?(): number;
  newId?(): string;
  /**
   * Fix round 1 (M-4) / round 2 (FLAKE-3): waited once before `list()` retries a transient manifest parse failure.
   * Defaults to `LIST_RETRY_DELAY_MS`.
   */
  listRetryWait?: () => Promise<void>;
  onOperation(operation: NpmOperation): void;
  onLog(opId: string, text: string): void;
  onChanged(list: NpmListResult): void;
  /** After a successful change (spec §11.3): recycle spares, invalidate types, invalidate web vendor caches (M4). */
  afterChange(): void;
  log(message: string, detail?: unknown): void;
}

type RunStep = (argv: readonly string[]) => Promise<NpmSpawnResult>;
const OK: NpmSpawnResult = { exitCode: 0, stdout: "", stderr: "" };
const LIST_RETRY_DELAY_MS = 100;

const combineResults = (first: NpmSpawnResult, second: NpmSpawnResult): NpmSpawnResult => ({
  exitCode: second.exitCode,
  stdout: `${first.stdout}\n${second.stdout}`,
  stderr: `${first.stderr}\n${second.stderr}`,
});

/** The npm service (spec §11): one queue, the isolated environment, and change notifications. */
export class NpmService {
  protected readonly queue: OperationQueue;
  #idle: Promise<void> = Promise.resolve();

  constructor(protected readonly deps: NpmServiceDeps) {
    this.queue = deps.queue ?? new OperationQueue();
  }

  install(spec: string): NpmOperation {
    const parsed = parseInstallSpec(spec);
    return this.operation("install", spec, async (run, markChanged) => {
      const allowScripts = this.deps.settings().allowInstallScripts;
      const before = await this.readManifest();
      const wasTrusted = parsed?.kind === "registry" && before.trustedDependencies.includes(parsed.name);
      const grantsTrust = allowScripts && parsed?.kind === "registry" && !wasTrusted;
      if (grantsTrust) await this.#setTrusted(parsed.name, true);
      const addResult = await run(["add", "--exact", spec]);
      if (addResult.exitCode !== 0) {
        // Fix round 1 (M-2): a failed install never leaves behind trust it granted.
        if (grantsTrust) await this.#setTrusted(parsed.name, false);
        return addResult;
      }
      // Fix round 1 (M-3): the change already happened (package.json/node_modules), regardless of what follows.
      markChanged();
      if (!allowScripts || parsed?.kind === "registry") return addResult;
      const after = await this.readManifest();
      const added = Object.keys(after.dependencies).filter((name) => !(name in before.dependencies));
      if (added.length === 0) return addResult;
      const trustResult = await run(["pm", "trust", ...added]);
      return combineResults(addResult, trustResult);
    });
  }

  remove(name: string): NpmOperation {
    return this.operation("remove", name, async (run) => {
      const result = await run(["remove", name]);
      if (result.exitCode === 0) await this.#setTrusted(name, false);
      return result;
    });
  }

  update(name: string): NpmOperation {
    return this.operation("update", name, (run) => run(["add", "--exact", `${name}@latest`]));
  }

  updateAll(): NpmOperation {
    return this.operation("updateAll", "", async (run) => {
      const names = Object.keys((await this.readManifest()).dependencies);
      return names.length === 0 ? OK : run(["add", "--exact", ...names.map((name) => `${name}@latest`)]);
    });
  }

  /** Fix round 1 (M-4): retries once, after a short delay, when the manifest read hits a transient parse race. */
  async list(_options: { refreshOutdated: boolean } = { refreshOutdated: false }): Promise<NpmListResult> {
    let installed: InstalledPackage[];
    try {
      installed = await this.installedPackages(new Map());
    } catch {
      await (this.deps.listRetryWait ?? (() => Bun.sleep(LIST_RETRY_DELAY_MS)))();
      installed = await this.installedPackages(new Map());
    }
    return { installed, outdatedCheckedAt: null, outdatedError: null };
  }

  /** Resolves once every queued operation, including ones queued while waiting, has finished. */
  async whenIdle(): Promise<void> {
    let current: Promise<void>;
    do {
      current = this.#idle;
      await current;
    } while (current !== this.#idle);
  }

  protected operation(
    kind: NpmOpKind,
    target: string,
    body: (run: RunStep, markChanged: () => void) => Promise<NpmSpawnResult>,
  ): NpmOperation {
    const op: NpmOperation = {
      id: (this.deps.newId ?? (() => crypto.randomUUID()))(),
      kind,
      target,
      status: "queued",
      error: null,
      notice: null,
    };
    this.#safeEmit(op);
    let changed = false;
    const done = this.queue
      .run(async (signal) => {
        this.#safeEmit({ ...op, status: "running" });
        return body(
          (argv) => {
            // Fix round 1 (I-1): once the queue has aborted this operation, no further step may spawn.
            if (signal.aborted) return Promise.reject(new Error("npm operation aborted before this step"));
            return this.spawnStep(argv, signal, (text) => this.deps.onLog(op.id, text));
          },
          () => {
            changed = true;
          },
        );
      })
      .then(
        (result) => this.#finish(op, result, false, changed),
        (error: unknown) => {
          // Fix round 1 (I-1): a timeout that settled within the kill grace classifies from the child's real output.
          if (error instanceof OperationTimeoutError && error.settled) {
            return this.#finish(op, error.settled.value as NpmSpawnResult, true, changed);
          }
          return this.#finish(
            op,
            { exitCode: null, stdout: "", stderr: String(error) },
            error instanceof OperationTimeoutError,
            changed,
          );
        },
      );
    // Fix round 1 (M-1): `done` must never reject, or every later operation chained onto #idle would inherit it.
    const guardedDone = done.catch((error) => {
      this.deps.log(strings.log.npmPostChangeFailed, String(error));
    });
    this.#idle = this.#idle.then(() => guardedDone);
    return op;
  }

  protected spawnStep(
    argv: readonly string[],
    signal: AbortSignal,
    onOutput: (text: string) => void,
  ): Promise<NpmSpawnResult> {
    const base = this.deps.baseEnv();
    const env = npmEnvironment({
      base,
      npmHome: this.deps.paths.npmHome,
      bunCacheDir: this.deps.cacheDirOverride ?? resolveBunCacheDir(base, this.deps.realHome),
    });
    return this.deps.spawn(argv, { cwd: this.deps.paths.packagesDir, env, signal, onOutput });
  }

  /** Called after each successful change, before the new list is reported (Task 12 resets the outdated cache here). */
  protected onSucceeded(): void {}

  async #finish(op: NpmOperation, result: NpmSpawnResult, timedOut: boolean, forceChange: boolean): Promise<void> {
    const error = classifyNpmFailure({ ...result, timedOut });
    const notice = error ? null : detectNotice(result);
    this.#safeEmit({ ...op, status: error ? "failed" : "succeeded", error, notice });
    // Fix round 1 (M-3): a real change (markChanged()) still gets its post-change steps, even if this op failed.
    if (error && !forceChange) return;
    try {
      this.onSucceeded();
      this.deps.afterChange();
      this.deps.onChanged(await this.list());
    } catch (failure) {
      this.deps.log(strings.log.npmPostChangeFailed, String(failure));
    }
  }

  /** Fix round 1 (M-1): an emission the caller (Task 18's RPC push) throws on can never break the queue's bookkeeping. */
  #safeEmit(op: NpmOperation): void {
    try {
      this.deps.onOperation(op);
    } catch (error) {
      this.deps.log(strings.log.npmOperationEventFailed, error);
    }
  }

  /**
   * Fix round 1 (I-2): the default, empty manifest is returned ONLY when packages.json doesn't exist yet. Any other
   * read failure — a parse error, or a top level that isn't a plain object — fails the caller instead of silently
   * replacing the user's project with the empty default.
   */
  protected async readManifest(): Promise<PackagesManifest> {
    let raw: string;
    try {
      raw = await readFile(this.deps.paths.packagesJson, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return defaultPackagesManifest();
      throw new Error(strings.log.npmManifestUnreadable(this.deps.paths.packagesJson), { cause: error });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(strings.log.npmManifestUnreadable(this.deps.paths.packagesJson), { cause: error });
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(strings.log.npmManifestUnreadable(this.deps.paths.packagesJson));
    }
    const partial = parsed as Partial<PackagesManifest>;
    const fallback = defaultPackagesManifest();
    return {
      ...fallback,
      ...partial,
      dependencies: typeof partial.dependencies === "object" && partial.dependencies ? partial.dependencies : {},
      trustedDependencies: Array.isArray(partial.trustedDependencies) ? partial.trustedDependencies : [],
    };
  }

  protected async installedPackages(latest: ReadonlyMap<string, string>): Promise<InstalledPackage[]> {
    const manifest = await this.readManifest();
    const installed: InstalledPackage[] = [];
    for (const name of Object.keys(manifest.dependencies).sort()) {
      const version = await this.installedVersion(name);
      const newest = latest.get(name) ?? null;
      installed.push({ name, version, latest: newest && newest !== version ? newest : null });
    }
    return installed;
  }

  protected async installedVersion(name: string): Promise<string | null> {
    try {
      const pkg = JSON.parse(await readFile(join(this.deps.paths.packagesNodeModules, name, "package.json"), "utf8"));
      return typeof pkg.version === "string" ? pkg.version : null;
    } catch {
      return null;
    }
  }

  async #setTrusted(name: string, trusted: boolean): Promise<void> {
    const manifest = await this.readManifest();
    const set = new Set(manifest.trustedDependencies);
    if (trusted === set.has(name)) return;
    if (trusted) set.add(name);
    else set.delete(name);
    await writeFileAtomic(
      this.deps.paths.packagesJson,
      `${JSON.stringify({ ...manifest, trustedDependencies: [...set].sort() }, null, 2)}\n`,
    );
  }
}
