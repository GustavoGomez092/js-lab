import { join } from "node:path";
import {
  authTokenFor,
  classifyNpmFailure,
  detectNotice,
  npmEnvironment,
  OperationQueue,
  OperationTimeoutError,
  parseInstallSpec,
  parseNpmrc,
  parseOutdated,
  parseSearchResponse,
  redactRegistryUrl,
  registryFor,
  resolveBunCacheDir,
  typesPackageName,
} from "@jslab/npm";
import type {
  InstalledPackage,
  NpmListResult,
  NpmOpError,
  NpmOperation,
  NpmOpKind,
  NpmSearchResponse,
} from "@jslab/rpc-schema";
import { defaultPackagesManifest, type PackagesManifest } from "@jslab/shared";
import type { AppPaths } from "../app-paths";
import {
  MAX_NODE_MODULES_FILE_BYTES,
  MAX_NPMRC_BYTES,
  MAX_STATE_FILE_BYTES,
  readBoundedText,
} from "../files/bounded-read";
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
  /** R-M3-OUTDATED-1: overrides `OUTDATED_TIMEOUT_MS` for tests, so a short deadline needs no real 30 s wait. */
  outdatedTimeoutMs?: number;
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

/** Spec §11.3: `bun outdated` runs at most every 10 minutes. */
export const OUTDATED_TTL_MS = 10 * 60_000;
/**
 * R-M3-OUTDATED-1: `bun outdated`'s own deadline, far below the queue's 5-minute `NPM_OPERATION_TIMEOUT_MS` — a
 * stalled registry (a blackholed connect, a DNS stall) must never hold up an install, remove, update or Update all
 * queued behind it for anywhere near that long.
 */
export const OUTDATED_TIMEOUT_MS = 30_000;
export const SEARCH_TIMEOUT_MS = 8_000;
/** Fix round 1 (M-3): a search response body is never buffered past this many bytes. */
export const MAX_SEARCH_BODY_BYTES = 1_048_576;

/** Fix round 1 (M-3): thrown by `readCappedJson` so `search()` can classify it as `"unknown"`, not `"network"`. */
class SearchBodyTooLargeError extends Error {}

/** Reads `response`'s body with a byte cap (M-3), never buffering more than `capBytes` before failing. */
async function readCappedJson(response: Response, capBytes: number): Promise<unknown> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > capBytes) {
    await response.body?.cancel();
    throw new SearchBodyTooLargeError(`search response body exceeds ${capBytes} bytes`);
  }
  const reader = response.body?.getReader();
  if (!reader) return response.json();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > capBytes) {
      await reader.cancel();
      throw new SearchBodyTooLargeError(`search response body exceeds ${capBytes} bytes`);
    }
    chunks.push(value);
  }
  return JSON.parse(await new Blob(chunks).text());
}

/** Fix round 1 (M-2): walks `exports`, recursively through objects and arrays, for a `types` key (spec §6.2). */
function exportsHaveTypes(node: unknown): boolean {
  if (node === null || typeof node !== "object") return false;
  if (Array.isArray(node)) return node.some((item) => exportsHaveTypes(item));
  const record = node as Record<string, unknown>;
  if ("types" in record) {
    const value = record.types;
    if (typeof value === "string" || (typeof value === "object" && value !== null)) return true;
  }
  return Object.values(record).some((value) => exportsHaveTypes(value));
}

const combineResults = (first: NpmSpawnResult, second: NpmSpawnResult): NpmSpawnResult => ({
  exitCode: second.exitCode,
  stdout: `${first.stdout}\n${second.stdout}`,
  stderr: `${first.stderr}\n${second.stderr}`,
});

/** The npm service (spec §11): one queue, the isolated environment, and change notifications. */
export class NpmService {
  protected readonly queue: OperationQueue;
  #idle: Promise<void> = Promise.resolve();
  #outdated: { at: number; latest: Map<string, string>; error: NpmOpError | null } | null = null;
  #refreshing = false;
  /** R-M3-OUTDATED-1: stamps every `list()` snapshot; monotonic for the life of this service (never resets). */
  #listRevision = 0;
  /** R-M3-OUTDATED-1: aborts the current refresh, whether it's already spawned or still waiting in the queue. */
  #outdatedPreempt: AbortController | null = null;

  constructor(protected readonly deps: NpmServiceDeps) {
    this.queue = deps.queue ?? new OperationQueue();
  }

  install(spec: string): NpmOperation {
    const parsed = parseInstallSpec(spec);
    return this.operation(
      "install",
      spec,
      async (run, markChanged) => {
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
      },
      // Task 12: after a successful registry install, offer @types/<name> when it has none of its own.
      parsed?.kind === "registry" ? () => this.#maybeInstallTypes(parsed.name) : undefined,
    );
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

  /**
   * Fix round 1 (M-4): retries once, after a short delay, when the manifest read hits a transient parse race.
   * Task 12: fills `latest`/`outdatedCheckedAt`/`outdatedError` from the `bun outdated` cache (spec §11.3), and, when
   * asked to refresh a cache older than `OUTDATED_TTL_MS`, starts one background refresh through the queue.
   */
  async list(options: { refreshOutdated: boolean } = { refreshOutdated: false }): Promise<NpmListResult> {
    const now = (this.deps.now ?? Date.now)();
    if (options.refreshOutdated && (!this.#outdated || now - this.#outdated.at >= OUTDATED_TTL_MS)) {
      void this.#refreshOutdated();
    }
    // R-M3-OUTDATED-1: stamped here, at snapshot time (this line and the next read the exact state this result
    // reflects), not when the result is later sent — so a result computed earlier can never carry a higher
    // revision than one computed after it, whatever order the response and a `npm.changed` push are delivered in.
    const revision = ++this.#listRevision;
    const cache = this.#outdated;
    const latest = cache?.latest ?? new Map<string, string>();
    let installed: InstalledPackage[];
    try {
      installed = await this.installedPackages(latest);
    } catch {
      await (this.deps.listRetryWait ?? (() => Bun.sleep(LIST_RETRY_DELAY_MS)))();
      installed = await this.installedPackages(latest);
    }
    return { installed, outdatedCheckedAt: cache?.at ?? null, outdatedError: cache?.error ?? null, revision };
  }

  /** Registry search (spec §11.3): `GET <registry>/-/v1/search`, with the registry/token resolved from `.npmrc`. */
  async search(query: string): Promise<NpmSearchResponse> {
    let registry: string;
    let token: string | null;
    try {
      ({ registry, token } = await this.#registry(query.startsWith("@") ? query : null));
    } catch (error) {
      // FR-12: a non-ENOENT .npmrc read failure must fail the search, not silently retarget it at the public
      // registry with the user's (possibly internal) query text.
      return { results: [], error: { kind: "disk", log: String(error) } };
    }
    // Fix round 1 (M-6): a registry URL with embedded credentials never reaches a log or error.
    const redacted = redactRegistryUrl(registry);
    try {
      const response = await (this.deps.fetch ?? fetch)(
        `${registry}-/v1/search?text=${encodeURIComponent(query)}&size=25`,
        { headers: token ? { authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS) },
      );
      if (!response.ok) {
        // Fix round 1 (M-3): a non-2xx body is never left open.
        await response.body?.cancel();
        return {
          results: [],
          error: {
            kind: response.status === 404 ? "notFound" : "unknown",
            log: `GET ${redacted}-/v1/search: HTTP ${response.status}`,
          },
        };
      }
      const json = await readCappedJson(response, MAX_SEARCH_BODY_BYTES);
      // Fix round 1 (M-3): the parsed count is capped too, in case a misconfigured registry ignores `size`.
      return { results: parseSearchResponse(json).slice(0, 25), error: null };
    } catch (error) {
      return {
        results: [],
        error: {
          kind: error instanceof SearchBodyTooLargeError ? "unknown" : "network",
          log: `GET ${redacted}-/v1/search: ${String(error)}`,
        },
      };
    }
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
    /** Task 12: runs once, after a genuinely successful op's post-change steps (e.g. the auto-@types check). */
    afterSucceeded?: () => Promise<void>,
  ): NpmOperation {
    // R-M3-OUTDATED-1: a user operation preempts an outdated refresh that's queued or already running, so it
    // never waits behind it. Queued: the refresh task checks this abort as its first statement and returns
    // without spawning. Running: the abort kills the child through the same signal `spawnStep` already honours.
    this.#outdatedPreempt?.abort();
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
        (result) => this.#finish(op, result, false, changed, afterSucceeded),
        (error: unknown) => {
          // Fix round 1 (I-1): a timeout that settled within the kill grace classifies from the child's real output.
          if (error instanceof OperationTimeoutError && error.settled) {
            return this.#finish(op, error.settled.value as NpmSpawnResult, true, changed, afterSucceeded);
          }
          return this.#finish(
            op,
            { exitCode: null, stdout: "", stderr: String(error) },
            error instanceof OperationTimeoutError,
            changed,
            afterSucceeded,
          );
        },
      );
    // Fix round 1 (M-1): `done` must never reject, or every later operation chained onto #idle would inherit it.
    const guardedDone = done.catch((error) => {
      this.deps.log(strings.log.npmPostChangeFailed, String(error));
    });
    this.#track(guardedDone);
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

  /** Settings → NPM changed `.npmrc`: the cached outdated result may name another registry's versions. */
  resetOutdated(): void {
    this.onSucceeded();
  }

  /** Called after each successful change, before the new list is reported: a change invalidates the outdated cache. */
  protected onSucceeded(): void {
    this.#outdated = null;
  }

  async #finish(
    op: NpmOperation,
    result: NpmSpawnResult,
    timedOut: boolean,
    forceChange: boolean,
    afterSucceeded?: () => Promise<void>,
  ): Promise<void> {
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
    // Fix round 1 (M-4): its own try/catch, after the post-change block, so a throwing onChanged/list() can never
    // skip the types check, and a failure here is never mislabeled as a post-change failure.
    if (!error) {
      try {
        await afterSucceeded?.();
      } catch (failure) {
        this.deps.log(strings.log.npmTypesCheckFailed, String(failure));
      }
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
      raw = await readBoundedText(this.deps.paths.packagesJson, MAX_STATE_FILE_BYTES);
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
      const pkg = JSON.parse(
        await readBoundedText(
          join(this.deps.paths.packagesNodeModules, name, "package.json"),
          MAX_NODE_MODULES_FILE_BYTES,
        ),
      );
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

  /**
   * Fix round 1 (I-1): guards the promise itself, so a caller (like `#refreshOutdated`) can never poison `whenIdle`
   * by tracking a promise that rejects. `operation()`'s own `guardedDone` catch stays too; a double guard is
   * harmless.
   */
  #track(promise: Promise<void>): void {
    const guarded = promise.catch((error) => {
      this.deps.log(strings.log.npmPostChangeFailed, String(error));
    });
    this.#idle = this.#idle.then(() => guarded);
  }

  /**
   * Runs `bun outdated` at most once at a time, through the queue, and caches the result (spec §11.3).
   * R-M3-OUTDATED-1: the check gets its own `OUTDATED_TIMEOUT_MS` deadline, far below the queue's 5-minute one,
   * and a user operation can preempt it (queued or running) through `#outdatedPreempt`. A preempted refresh is
   * advisory: it never records an error and never overwrites `#outdated`, so the next sheet open just re-checks.
   */
  async #refreshOutdated(): Promise<void> {
    if (this.#refreshing) return;
    this.#refreshing = true;
    const preempt = new AbortController();
    this.#outdatedPreempt = preempt;
    const timeoutMs = this.deps.outdatedTimeoutMs ?? OUTDATED_TIMEOUT_MS;
    const run = this.queue.run((signal) => {
      // (a) from the analysis: a refresh still queued when it's preempted never spawns at all, so the operation
      // right behind it in the queue starts as soon as this task's promise settles, not after a spawn+kill.
      if (preempt.signal.aborted) return Promise.resolve(null);
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const combined = AbortSignal.any([signal, preempt.signal, timeoutSignal]);
      return this.spawnStep(["outdated"], combined, () => {}).then(
        (result): { result: NpmSpawnResult; timedOut: boolean } => ({ result, timedOut: timeoutSignal.aborted }),
      );
    });
    const done = run
      .then(
        (outcome) => {
          // Preempted, whether it never spawned (outcome is null) or was aborted mid-spawn: leave the cache as
          // it was, and record no error, so an absent `latest` never shows a hint that nothing actually failed.
          if (outcome === null || preempt.signal.aborted) return;
          const error = classifyNpmFailure({ ...outcome.result, timedOut: outcome.timedOut });
          const latest = new Map(
            parseOutdated(`${outcome.result.stdout}\n${outcome.result.stderr}`).map((entry) => [
              entry.name,
              entry.latest,
            ]),
          );
          this.#outdated = { at: (this.deps.now ?? Date.now)(), latest: error ? new Map() : latest, error };
        },
        (error: unknown) => {
          if (preempt.signal.aborted) return;
          // R-M3-T12-KIND-1: classify like `operation()` does, instead of always recording "timeout".
          this.#outdated = {
            at: (this.deps.now ?? Date.now)(),
            latest: new Map(),
            error: { kind: error instanceof OperationTimeoutError ? "timeout" : "unknown", log: String(error) },
          };
        },
      )
      .then(async () => {
        this.deps.onChanged(await this.list({ refreshOutdated: false }));
      })
      // Fix round 1 (I-1): reset in a `finally`, so a throw anywhere in the chain above can never leave a burst
      // guard stuck forever.
      .finally(() => {
        this.#refreshing = false;
        if (this.#outdatedPreempt === preempt) this.#outdatedPreempt = null;
      });
    this.#track(done);
  }

  /** The registry and auth token for `packageName` (or the default registry when `packageName` is null). */
  async #registry(packageName: string | null): Promise<{ registry: string; token: string | null }> {
    const base = this.deps.baseEnv();
    const config = parseNpmrc(await this.#readNpmrc());
    const registry = registryFor(config, packageName, base);
    return { registry, token: authTokenFor(config, registry, base) };
  }

  /**
   * FR-12: the same bare-catch anti-pattern readManifest's I-2 fixed (FR-2's sibling), in the registry-selection
   * path. The empty config that makes registryFor fall back to the public registry is used ONLY when .npmrc
   * doesn't exist yet; any other read failure (permission drift, transient I/O) fails the caller instead of
   * silently retargeting a private registry to the public one.
   */
  async #readNpmrc(): Promise<string> {
    try {
      return await readBoundedText(this.deps.paths.packagesNpmrc, MAX_NPMRC_BYTES);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return "";
      throw new Error(strings.log.npmNpmrcUnreadable(this.deps.paths.packagesNpmrc), { cause: error });
    }
  }

  /**
   * Task 12: after a successful registry install, offers `@types/<name>` when the registry has it and it's needed.
   * Fix round 1 (M-4): `name` is confirmed still a dependency both before the network round trip and immediately
   * before queuing the `@types` install, so a package removed in between (spec §11.2) never gets stray types.
   */
  async #maybeInstallTypes(name: string): Promise<void> {
    if (!this.deps.settings().autoInstallTypes) return;
    const typesName = typesPackageName(name);
    if (!typesName || (await this.#hasOwnTypes(name))) return;
    try {
      const before = await this.readManifest();
      if (!(name in before.dependencies) || typesName in before.dependencies) return;
      const { registry, token } = await this.#registry(typesName);
      // Fix round 1 (M-3): the abbreviated packument is enough to test existence; only the status matters.
      const response = await (this.deps.fetch ?? fetch)(`${registry}${typesName.replace("/", "%2f")}`, {
        headers: {
          accept: "application/vnd.npm.install-v1+json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
      });
      const found = response.ok;
      await response.body?.cancel();
      if (!found) return;
      const current = await this.readManifest();
      if (!(name in current.dependencies) || typesName in current.dependencies) return;
      this.install(typesName);
    } catch (error) {
      this.deps.log(strings.log.npmTypesCheckFailed, String(error));
    }
  }

  /**
   * Fix round 1 (M-2): typed only via `types`/`typings`, an `exports` `types` condition (spec §6.2), or a bundled
   * `index.d.ts`. A plain `"types"` substring elsewhere in the manifest (a keyword, a `files` entry) doesn't count.
   */
  async #hasOwnTypes(name: string): Promise<boolean> {
    let pkg: { types?: unknown; typings?: unknown; exports?: unknown };
    try {
      const text = await readBoundedText(
        join(this.deps.paths.packagesNodeModules, name, "package.json"),
        MAX_NODE_MODULES_FILE_BYTES,
      );
      pkg = JSON.parse(text) as { types?: unknown; typings?: unknown; exports?: unknown };
    } catch {
      return false;
    }
    if (typeof pkg.types === "string" && pkg.types.length > 0) return true;
    if (typeof pkg.typings === "string" && pkg.typings.length > 0) return true;
    if (exportsHaveTypes(pkg.exports)) return true;
    return Bun.file(join(this.deps.paths.packagesNodeModules, name, "index.d.ts")).exists();
  }
}
