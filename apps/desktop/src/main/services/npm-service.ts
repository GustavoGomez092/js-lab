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
  onOperation(operation: NpmOperation): void;
  onLog(opId: string, text: string): void;
  onChanged(list: NpmListResult): void;
  /** After a successful change (spec §11.3): recycle spares, invalidate types, invalidate web vendor caches (M4). */
  afterChange(): void;
  log(message: string, detail?: unknown): void;
}

type RunStep = (argv: readonly string[]) => Promise<NpmSpawnResult>;
const OK: NpmSpawnResult = { exitCode: 0, stdout: "", stderr: "" };

/** The npm service (spec §11): one queue, the isolated environment, and change notifications. */
export class NpmService {
  protected readonly queue: OperationQueue;
  #idle: Promise<void> = Promise.resolve();

  constructor(protected readonly deps: NpmServiceDeps) {
    this.queue = deps.queue ?? new OperationQueue();
  }

  install(spec: string): NpmOperation {
    const parsed = parseInstallSpec(spec);
    return this.operation("install", spec, async (run) => {
      const allowScripts = this.deps.settings().allowInstallScripts;
      const before = await this.readManifest();
      if (allowScripts && parsed?.kind === "registry") await this.#setTrusted(parsed.name, true);
      const result = await run(["add", "--exact", spec]);
      if (result.exitCode !== 0 || !allowScripts || parsed?.kind === "registry") return result;
      const after = await this.readManifest();
      const added = Object.keys(after.dependencies).filter((name) => !(name in before.dependencies));
      return added.length > 0 ? run(["pm", "trust", ...added]) : result;
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

  async list(_options: { refreshOutdated: boolean } = { refreshOutdated: false }): Promise<NpmListResult> {
    return { installed: await this.installedPackages(new Map()), outdatedCheckedAt: null, outdatedError: null };
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
    body: (run: RunStep) => Promise<NpmSpawnResult>,
    afterSuccess?: () => Promise<void>,
  ): NpmOperation {
    const op: NpmOperation = {
      id: (this.deps.newId ?? (() => crypto.randomUUID()))(),
      kind,
      target,
      status: "queued",
      error: null,
      notice: null,
    };
    this.deps.onOperation(op);
    const done = this.queue
      .run(async (signal) => {
        this.deps.onOperation({ ...op, status: "running" });
        return body((argv) => this.spawnStep(argv, signal, (text) => this.deps.onLog(op.id, text)));
      })
      .then(
        (result) => this.#finish(op, result, false, afterSuccess),
        (error: unknown) =>
          this.#finish(
            op,
            { exitCode: null, stdout: "", stderr: String(error) },
            error instanceof OperationTimeoutError,
          ),
      );
    this.#idle = this.#idle.then(() => done);
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

  async #finish(
    op: NpmOperation,
    result: NpmSpawnResult,
    timedOut: boolean,
    afterSuccess?: () => Promise<void>,
  ): Promise<void> {
    const error = classifyNpmFailure({ ...result, timedOut });
    const notice = error ? null : detectNotice(result);
    this.deps.onOperation({ ...op, status: error ? "failed" : "succeeded", error, notice });
    if (error) return;
    try {
      this.onSucceeded();
      this.deps.afterChange();
      this.deps.onChanged(await this.list({ refreshOutdated: false }));
      await afterSuccess?.();
    } catch (failure) {
      this.deps.log(strings.log.npmPostChangeFailed, String(failure));
    }
  }

  protected async readManifest(): Promise<PackagesManifest> {
    try {
      const raw = JSON.parse(await readFile(this.deps.paths.packagesJson, "utf8")) as Partial<PackagesManifest>;
      const fallback = defaultPackagesManifest();
      return {
        ...fallback,
        ...raw,
        dependencies: typeof raw.dependencies === "object" && raw.dependencies ? raw.dependencies : {},
        trustedDependencies: Array.isArray(raw.trustedDependencies) ? raw.trustedDependencies : [],
      };
    } catch {
      return defaultPackagesManifest();
    }
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
