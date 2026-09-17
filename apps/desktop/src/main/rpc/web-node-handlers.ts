import { spawn as nodeSpawn } from "node:child_process";
import { access, appendFile, copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { type WebNodeStat, webNodeCallSchema } from "@jslab/rpc-schema";
import type { Redactor } from "../logging/redact";
import { createValidators, type Log } from "./validate";

/**
 * The Main-side half of `browser-node`'s async Node bridge (spec §5.13).
 *
 * Only `browser-node` is bridged. A `browser` tab has no Node builtins at all -- the bundler refuses every one of
 * them outright (`../bundling/polyfill-plugin.ts`) -- so a `browser` page can never legitimately produce a call
 * here, and a forged one is refused by the session before this module sees it.
 *
 * **Identity is structural, never data.** Following the precedent Task 13's fix round 1 set for `web-fetch-
 * handlers.ts`: there is no `tabId` parameter in this module, and none on the wire. One runner is created per
 * `WebRunSession` (`../runtimes/web-adapter.ts`), which already knows which tab it belongs to and which runtime is
 * driving it, from the `WebviewHost` the connection arrived on. A page cannot name another tab's context because it
 * is never asked to name one.
 *
 * **Permissions: the same as `bun`, deliberately (ruling on spec §5.13 line 509).** An earlier draft of this module
 * confined every path to the tab's working directory and refused outright when a tab had none. That was wrong on
 * three counts and has been removed:
 * - **Parity.** A script that works in a `bun` tab must keep working when the tab is switched to `browser-node`.
 *   Confinement breaks that outright, and parity is the promise `docs/parity.md` exists to track.
 * - **`browser-node` is the default runtime**, and most tabs have no working directory, so fail-closed shipped the
 *   feature dead for the ordinary user.
 * - **It was false assurance.** `bun` tabs already run unconfined with the user's own permissions; confining only
 *   this runtime made the two inconsistent while offering protection nobody could rely on.
 *
 * What remains is a *resolution* rule, not a permission one: a relative path resolves against `baseDirectory`, and
 * that base is chosen to match the Bun runner exactly (see `WebNodeRunnerDeps.baseDirectory`).
 *
 * **Redaction is scoped to logged diagnostics only, and that is a correctness requirement, not a stylistic one.**
 * `createRedactor` (`../logging/redact.ts`) is a *logging* helper: it masks known environment secret values and
 * credential-shaped tokens in already-serialized log lines. Applying it to a value the user's program asked for
 * would silently corrupt that value -- a `readFile` of a `.env` file would come back with the user's own secret
 * replaced by `[REDACTED]`, and a `child_process` run that printed a token would have its stdout rewritten
 * underneath the program reading it. A file read returning altered bytes is a far worse failure than an
 * unredacted log line, and it is undetectable from inside the tab. So: `deps.log` calls are redacted; the `value`
 * of a result, and every `stdout`/`stderr` payload, cross back **unchanged**.
 */

/** The page-bound half of one reply, bound to whichever tab constructed this runner -- no `tabId` field needed. */
export interface WebNodeSend {
  result(payload: { id: number; value: unknown }): void;
  error(payload: { id: number; name: string; message: string; code?: string }): void;
  stdout(payload: { id: number; data: string }): void;
  stderr(payload: { id: number; data: string }): void;
  exit(payload: { id: number; code: number | null; signal: string | null }): void;
}

/** The filesystem operations this runner performs. A seam so tests drive it without touching a real disk. */
export interface WebNodeFs {
  readFile(path: string): Promise<Buffer>;
  writeFile(path: string, data: Buffer): Promise<void>;
  appendFile(path: string, data: Buffer): Promise<void>;
  readdir(path: string): Promise<string[]>;
  mkdir(path: string, options: { recursive: boolean }): Promise<void>;
  rm(path: string, options: { recursive: boolean; force: boolean }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  copyFile(from: string, to: string): Promise<void>;
  stat(path: string): Promise<WebNodeStat>;
  access(path: string): Promise<void>;
}

/** What a page may ask for when starting a command. Honoured, matching Node and the `bun` runtime. */
export interface WebNodeCommandOptions {
  cwd?: string;
  env?: Record<string, string>;
  shell?: boolean | string;
}

export interface WebNodeRunnerDeps {
  send: WebNodeSend;
  /** Spec §18: applied to what JSLab *logs* about a call. Never to returned data or stream payloads. */
  redact: Redactor;
  log: Log;
  /**
   * Where a relative path resolves from, and the default cwd for a command.
   *
   * **This is a parity value, not a policy one**, and it mirrors one line of the Bun runtime:
   * `../runs/runner-config.ts` computes `const cwd = workingDirectory ?? deps.paths.dataDir` and then sets
   * `env.PWD = cwd`. So a tab with a working directory resolves against it, and a tab **without** one resolves
   * against the app's data directory -- not the app's process cwd, and not a refusal. The caller
   * (`../runtimes/web-adapter.ts`) computes it with that same expression, so the two runtimes cannot drift apart
   * silently: the same relative path reaches the same file under `bun` and under `browser-node`.
   */
  baseDirectory: string;
  /**
   * The environment a bridged command gets when the caller supplies none (Task 9f item 6).
   *
   * **A parity value, exactly like `baseDirectory` above.** The Bun runner composes its environment through
   * `runnerEnvironment` (`../app-paths.ts`): the login shell, then env.json, then the working directory's `.env`,
   * with every `JSLAB_*` key and `BUN_OPTIONS` stripped and `JSLAB=1`/`NODE_PATH` set. This runner used to default
   * to Main's own raw `process.env` instead, so the same `child_process` call saw a different environment under
   * `browser-node` than under `bun` -- a user's `.env` simply never applied, and Main's own `JSLAB_*` variables
   * leaked into the child. Both runtimes now build this through the one shared `runnerContextFor`
   * (`../runs/runner-config.ts`), so they cannot drift apart silently.
   *
   * Optional for the same reason `baseDirectory`'s caller-side fallback is: this module's large existing fixture
   * set predates it. `../runtimes/web-adapter.ts` always supplies it in production.
   */
  baseEnvironment?: Record<string, string>;
  /** Test seam; production uses the real `node:fs/promises`. */
  fs?: WebNodeFs;
  /** Test seam; production uses the real `node:child_process.spawn`. */
  spawn?: typeof nodeSpawn;
}

export interface WebNodeRunner {
  call(id: number, payload: unknown): void;
  abort(id: number): void;
  /** Running children. A diagnostic seam: a child left behind after `abortAll` is a leak. */
  pending(): number;
  /** Kills everything still running -- called when the owning session retires. */
  abortAll(): void;
}

const realFs: WebNodeFs = {
  readFile: (path) => readFile(path),
  writeFile: (path, data) => writeFile(path, data),
  appendFile: (path, data) => appendFile(path, data),
  readdir: (path) => readdir(path),
  mkdir: async (path, options) => void (await mkdir(path, options)),
  rm: (path, options) => rm(path, options),
  rename: (from, to) => rename(from, to),
  copyFile: (from, to) => copyFile(from, to),
  stat: async (path) => {
    const stats = await stat(path);
    return {
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      isFile: stats.isFile(),
      isDirectory: stats.isDirectory(),
    };
  },
  access: (path) => access(path),
};

/**
 * Builds one tab's Node bridge runner. Construct one per `WebRunSession`, only once its `deps.runtime` is already
 * known to be `"browser-node"` -- this module trusts the caller for that, exactly as `web-fetch-handlers.ts` does,
 * because it has no identity of its own to check one against.
 */
export function createWebNodeRunner(deps: WebNodeRunnerDeps): WebNodeRunner {
  const { parse } = createValidators(deps.log);
  const fs = deps.fs ?? realFs;
  const spawnProcess = deps.spawn ?? nodeSpawn;
  const children = new Map<number, { kill(): void }>();

  /**
   * Resolves one caller-supplied path, exactly as Node would from the runner's cwd. An absolute path is returned
   * unchanged; a relative one is taken from `baseDirectory`.
   *
   * There is no containment check here, by ruling: these calls carry the user's own permissions, the same as a
   * `bun` tab (see this module's header). Paths still cannot contain control characters -- a NUL can truncate a
   * path inside a syscall -- but that refusal lives in the schema (`@jslab/rpc-schema`'s `webNodeCallSchema`),
   * because it is about the path being well-formed, not about where it points.
   */
  const resolvePath = (rawPath: string): string => resolve(deps.baseDirectory, rawPath);

  /** Answers a call that will not be performed, so it surfaces as a rejection instead of a promise that never settles. */
  function refuse(id: number, error: Error): void {
    const message = deps.redact(error.message);
    deps.log("Web node call refused", message);
    deps.send.error({
      id,
      name: error.name,
      message,
      ...((error as Error & { code?: string }).code ? { code: (error as Error & { code?: string }).code } : {}),
    });
  }

  async function runFs(id: number, method: string, args: unknown[]): Promise<void> {
    switch (method) {
      case "readFile": {
        // The returned body is NOT redacted (see this module's header): these are the exact bytes the user's
        // program asked for, and a file whose contents merely look like a credential must come back byte-identical.
        deps.send.result({ id, value: (await fs.readFile(resolvePath(args[0] as string))).toString("base64") });
        return;
      }
      case "writeFile": {
        await fs.writeFile(resolvePath(args[0] as string), Buffer.from(args[1] as string, "base64"));
        deps.send.result({ id, value: null });
        return;
      }
      case "appendFile": {
        await fs.appendFile(resolvePath(args[0] as string), Buffer.from(args[1] as string, "base64"));
        deps.send.result({ id, value: null });
        return;
      }
      case "readdir": {
        deps.send.result({ id, value: await fs.readdir(resolvePath(args[0] as string)) });
        return;
      }
      case "mkdir": {
        await fs.mkdir(resolvePath(args[0] as string), args[1] as { recursive: boolean });
        deps.send.result({ id, value: null });
        return;
      }
      case "rm": {
        await fs.rm(resolvePath(args[0] as string), args[1] as { recursive: boolean; force: boolean });
        deps.send.result({ id, value: null });
        return;
      }
      case "rename": {
        await fs.rename(resolvePath(args[0] as string), resolvePath(args[1] as string));
        deps.send.result({ id, value: null });
        return;
      }
      case "copyFile": {
        await fs.copyFile(resolvePath(args[0] as string), resolvePath(args[1] as string));
        deps.send.result({ id, value: null });
        return;
      }
      case "stat": {
        deps.send.result({ id, value: await fs.stat(resolvePath(args[0] as string)) });
        return;
      }
      case "access": {
        await fs.access(resolvePath(args[0] as string));
        deps.send.result({ id, value: null });
        return;
      }
      default:
        // Unreachable while the schema constrains `method`; answered rather than dropped all the same, so a future
        // schema entry with no branch here cannot leave a page's promise pending forever.
        refuse(id, new Error(`Unsupported fs call: ${method}`));
    }
  }

  /**
   * Starts one child process.
   *
   * `cwd`, `env` and `shell` are honoured, matching Node and the `bun` runtime -- `exec(cmd, { cwd })` is ordinary
   * Node, and dropping it would be its own parity bug. A relative `cwd` resolves from `baseDirectory`, the same
   * way a path argument does.
   *
   * `PWD` is set to the cwd the process actually gets, mirroring `../runs/runner-config.ts`'s `env.PWD = cwd`, so a
   * command reports the same working directory under both runtimes rather than inheriting Main's stale one.
   */
  async function runChildProcess(id: number, method: string, args: unknown[]): Promise<void> {
    // Ids are page-generated, and the schema only bounds them to a positive integer -- nothing makes one unique.
    // A repeat while the first command is still running would overwrite its entry in `children` below, leaving the
    // first process with no reachable kill handle: `abort(id)` and `abortAll()` would both only ever find the
    // newcomer, so the original would outlive the run. Refusing the newcomer keeps the command already running
    // abortable, exactly as `web-fetch-handlers.ts` does for a repeated request id. This sits **before** the spawn
    // on purpose: refusing after the fact would still have started the process.
    if (children.has(id)) {
      refuse(id, new Error("Ignored a repeated call id; the command already running continues."));
      return;
    }
    const command = String(args[0]);
    const commandArgs = Array.isArray(args[1]) ? (args[1] as unknown[]).map(String) : [];
    const options = (args[args.length - 1] ?? {}) as WebNodeCommandOptions;

    const cwd = options.cwd ? resolve(deps.baseDirectory, options.cwd) : deps.baseDirectory;
    // A page-supplied `env` replaces the default outright, as it does in Node. The default is the runner's own
    // layered environment (see `baseEnvironment`) -- the same one a `bun` tab's command would get -- rather than
    // Main's raw `process.env`. Either way PWD is corrected to the real cwd.
    const env = {
      ...(options.env ?? deps.baseEnvironment ?? (process.env as Record<string, string | undefined>)),
      PWD: cwd,
    };
    // Node's own defaults: `exec` always runs through a shell, `execFile`/`spawn` do not unless asked.
    const shell = options.shell ?? method === "exec";

    const child =
      method === "exec"
        ? spawnProcess(command, { cwd, env, shell: shell === false ? true : shell })
        : spawnProcess(command, commandArgs, { cwd, env, shell });

    children.set(id, { kill: () => child.kill() });
    // The command line is a diagnostic, so it IS redacted before it is logged -- a token passed as an argument
    // must not land in the log. The process's own output, below, is not.
    deps.log("Web node command", deps.redact([command, ...commandArgs].join(" ")));

    child.stdout?.on("data", (chunk: Buffer) => {
      // Unredacted by design: this is the program's own output, streamed to the code that asked for it.
      deps.send.stdout({ id, data: Buffer.from(chunk).toString("base64") });
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      deps.send.stderr({ id, data: Buffer.from(chunk).toString("base64") });
    });
    child.on("error", (error: Error) => {
      children.delete(id);
      refuse(id, error);
    });
    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      children.delete(id);
      deps.send.exit({ id, code, signal: signal ?? null });
    });
  }

  async function run(id: number, payload: unknown): Promise<void> {
    let call: { id: number; module: string; method: string; args: unknown[] };
    try {
      // Spec §18: every inbound payload is validated before use, through the same `createValidators` seam every
      // sibling handler group uses. An invalid one is answered here rather than dropped -- unlike a UI message,
      // a dropped bridged call leaves the page's promise pending forever.
      call = parse(webNodeCallSchema, "webNode.call", payload) as typeof call;
    } catch (error) {
      refuse(id, error instanceof Error ? error : new Error(String(error)));
      return;
    }

    try {
      if (call.module === "fs") {
        await runFs(id, call.method, call.args);
        return;
      }
      await runChildProcess(id, call.method, call.args);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      // Masked before it crosses back: a failure message can quote a path or a command line.
      const message = deps.redact(failure.message);
      deps.log("Web node call failed", message);
      deps.send.error({
        id,
        name: failure.name,
        message,
        ...((failure as Error & { code?: string }).code ? { code: (failure as Error & { code?: string }).code } : {}),
      });
    }
  }

  return {
    call(id, payload) {
      void run(id, payload);
    },
    abort(id) {
      const child = children.get(id);
      if (!child) return;
      // Release first, then kill: the entry is gone whatever the kill does, so an aborted call never leaks one.
      children.delete(id);
      child.kill();
    },
    pending: () => children.size,
    abortAll() {
      const running = [...children.values()];
      children.clear();
      for (const child of running) child.kill();
    },
  };
}
