/**
 * Task 11 (spec §5.13): the page-side half of `browser-node`'s async Node bridge.
 *
 * `fs/promises`, callback-style `fs.*` and `child_process.exec/execFile/spawn` have no browser implementation at
 * all, so every call is forwarded to Main over the same per-tab relay `fetch-proxy.ts` uses, and Main performs it
 * with the user's own permissions, scoped to the tab's working directory
 * (`apps/desktop/src/main/rpc/web-node-handlers.ts`).
 *
 * Everything Node does **synchronously** (`fs.readFileSync`, `child_process.execSync`, ...) is refused rather than
 * faked. The relay is asynchronous end to end, and a page cannot block its own main thread waiting on it without
 * deadlocking the very message loop the reply must arrive on -- so there is no honest synchronous implementation to
 * write. The refusal is an explicit, named error carrying the spec's own wording, not a missing property: the whole
 * point is that the failure names the runtime and states the way out, instead of surfacing as
 * `undefined is not a function` three frames into somebody's dependency.
 *
 * **Where the two halves live.** This module is the *client*, and it runs in the bootstrap
 * (`startRunnerWeb` calls `installNodeBridge`, which puts it on the page global). A tab's own bundle never
 * contains it: `apps/desktop/src/main/bundling/polyfill-plugin.ts` generates a few lines of glue for `fs`,
 * `fs/promises` and `child_process` that read that global, and imports this file for its **values** -- the method
 * lists and the refusal wording below -- so there is one source of truth for both without shipping the client into
 * every bundle. That plugin must not also text-import this file: Bun keys a module by resolved path and ignores
 * the `type: "text"` attribute when deciding identity, so importing it both ways in one program makes the first
 * load win and the named exports disappear (measured -- see that file's own note).
 *
 * Deliberately dependency-light, the same choice `fetch-proxy.ts` makes for its local `WebRuntime` type: nothing
 * here imports another package, so `bun test` drives it directly against a fake transport.
 */

/**
 * The page global the bundled `fs`/`child_process` modules read their client back out of.
 *
 * The two-runtime union is spelled inline at `installNodeBridge` below rather than exported as a `WebRuntime` type:
 * `fetch-proxy.ts` already exports a type by that name, and `src/index.ts` re-exports both modules with `export *`,
 * where two star-exports of one name make it ambiguous and drop it from the barrel.
 */
export const NODE_BRIDGE_GLOBAL = "__jslabNodeBridge";

export const UNSUPPORTED_ERROR_NAME = "JSLabUnsupportedError";

/**
 * What a bundled `fs`/`child_process` module throws when no bridge was ever installed on the page. Exported as a
 * constant because `apps/desktop/src/main/bundling/polyfill-plugin.ts` embeds it as a literal in the glue it
 * generates for a tab's bundle -- that glue cannot call into this module, so the text has to travel as data.
 */
export const NODE_BRIDGE_MISSING_MESSAGE =
  'The Node API bridge is not available in this tab. Switch this tab to the "Browser & Node APIs" or Bun runtime.';

/**
 * The refusal spec §5.13 pins by example at line 510 (`fs.readFileSync`). The **structure** is what the spec fixes:
 * name the method, name the async alternative, then give the switch-to-Bun hint.
 *
 * For `fs.*Sync` the wording is reproduced **verbatim**, alternative included (`fs/promises`). For
 * `child_process.*Sync` the alternative is that method's own async counterpart instead. An earlier draft
 * substituted only the method name, which produced "`child_process.execSync` … Use fs/promises …" -- advice that is
 * simply false for a process API. Line 513 shows the spec's own shape for an API with no async counterpart, so
 * naming the counterpart that *does* exist keeps the structure while telling the truth.
 */
export function unsupportedSyncMessage(method: string, alternative: string): string {
  return `${method} isn't available in "Browser & Node APIs". Use ${alternative} or switch this tab to the Bun runtime.`;
}

/** The async alternative named by every `fs.*Sync` refusal -- the spec's own wording, verbatim. */
export const FS_SYNC_ALTERNATIVE = "fs/promises";

/** The async counterpart of one `child_process.*Sync` method: `execSync` -> `child_process.exec`, and so on. */
export function childProcessSyncAlternative(method: string): string {
  return `child_process.${method.replace(/Sync$/, "")}`;
}

/** The switch-to-Bun hint for a module with no async form to redirect to (`http`, `net`, `tls`, ...). */
export function unsupportedModuleMessage(moduleName: string): string {
  return `${moduleName} isn't available in "Browser & Node APIs". Switch this tab to the Bun runtime.`;
}

/**
 * The refusal every §5.13 "not available here" path throws. `name` is set explicitly so `String(error)` renders as
 * `JSLabUnsupportedError: <message>` -- exactly the line the spec table quotes -- and so user code can branch on
 * `error.name` rather than on `instanceof`, which would be false across the bundle boundary anyway: the glue
 * `polyfill-plugin.ts` generates for a tab constructs its own `Error` and stamps the same name on it, because it
 * cannot reach this class.
 */
export class JSLabUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = UNSUPPORTED_ERROR_NAME;
  }
}

/** Throws the §5.13 sync refusal for `method` (e.g. `"fs.readFileSync"`), naming `alternative`. Never returns. */
export function throwUnsupportedSync(method: string, alternative: string): never {
  throw new JSLabUnsupportedError(unsupportedSyncMessage(method, alternative));
}

/**
 * Whether one argument is a command's options bag rather than its argument vector. Node's own signatures are
 * variadic (`spawn(file[, args][, options])`), so the options are found by shape, exactly as Node finds them.
 * Only the keys Main honours are carried; anything else is ignored rather than forwarded.
 */
function isOptionsObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && typeof value !== "function";
}

/** One page->Main call. `args` is JSON-safe: binary payloads are base64 (the relay carries JSON only). */
export interface NodeCallRequest {
  module: "fs" | "child_process";
  method: string;
  args: unknown[];
}

/** What Main sends back for one call id. */
export type NodeHostEvent =
  | { type: "result"; id: number; value: unknown }
  | { type: "error"; id: number; name: string; message: string; code?: string }
  | { type: "stdout"; id: number; data: string }
  | { type: "stderr"; id: number; data: string }
  | { type: "exit"; id: number; code: number | null; signal: string | null };

export interface NodeTransport {
  /** Hands one call to the host. */
  call(id: number, request: NodeCallRequest): void;
  /** Asks the host to abandon a call (killing a child process it started). */
  abort(id: number): void;
  /** Subscribes to the host's replies. Returns an unsubscribe function. */
  onEvent(listener: (event: NodeHostEvent) => void): () => void;
}

function decodeBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

/** The encoding named by a Node-style `options` argument (a bare string, or `{ encoding }`), or null for bytes. */
function encodingOf(options: unknown): string | null {
  if (typeof options === "string") return options;
  if (options !== null && typeof options === "object") {
    const encoding = (options as { encoding?: unknown }).encoding;
    if (typeof encoding === "string") return encoding;
  }
  return null;
}

/**
 * Turns Main's base64 file body into what the caller's `encoding` asked for.
 *
 * Bytes come back as a `Uint8Array` rather than a `Buffer`: `buffer` is a separate entry in the §5.13 table and a
 * tab that never imports it has no `Buffer` in scope at all, so constructing one here would make every binary read
 * depend on an unrelated polyfill being present. A documented divergence, not an oversight.
 */
function decodeBody(base64: string, encoding: string | null): string | Uint8Array {
  const bytes = decodeBase64(base64);
  if (encoding === null) return bytes;
  const lower = encoding.toLowerCase();
  if (lower === "base64") return base64;
  if (lower === "hex") return toHex(bytes);
  // Node's `binary` is an alias for `latin1`; `TextDecoder`'s own label list is typed as a closed union, so the
  // caller-supplied label is widened back to it here rather than pre-validated against a list this file would then
  // have to keep in step with the platform's.
  const label = lower === "binary" ? "latin1" : lower;
  return new TextDecoder(label as ConstructorParameters<typeof TextDecoder>[0]).decode(bytes);
}

/** Turns whatever a caller passed as file data into the base64 the relay carries. */
function encodeBody(data: unknown, encoding: string | null): string {
  if (typeof data === "string") {
    const lower = (encoding ?? "utf8").toLowerCase();
    if (lower === "base64") return data;
    if (lower === "hex") {
      const bytes = new Uint8Array(Math.floor(data.length / 2));
      for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = Number.parseInt(data.slice(index * 2, index * 2 + 2), 16);
      }
      return encodeBase64(bytes);
    }
    return encodeBase64(new TextEncoder().encode(data));
  }
  if (data instanceof Uint8Array) return encodeBase64(data);
  if (data instanceof ArrayBuffer) return encodeBase64(new Uint8Array(data));
  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    return encodeBase64(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  }
  return encodeBase64(new TextEncoder().encode(String(data)));
}

/** Rebuilds a host-reported failure as a real `Error`, keeping `name` and `code` so `err.code === "ENOENT"` works. */
function hostError(event: Extract<NodeHostEvent, { type: "error" }>): Error {
  const error = new Error(event.message);
  error.name = event.name;
  if (event.code !== undefined) (error as Error & { code?: string }).code = event.code;
  return error;
}

type Listener = (...args: unknown[]) => void;

/**
 * The few `EventEmitter` methods a `ChildProcess` consumer actually reaches for. A local implementation rather than
 * the `events` polyfill from the §5.13 table, for this module's import-free rule (see the header).
 */
class Emitter {
  readonly #listeners = new Map<string, Set<Listener>>();

  on(event: string, listener: Listener): this {
    let set = this.#listeners.get(event);
    if (!set) {
      set = new Set();
      this.#listeners.set(event, set);
    }
    set.add(listener);
    return this;
  }

  once(event: string, listener: Listener): this {
    const wrapped: Listener = (...args) => {
      this.off(event, wrapped);
      listener(...args);
    };
    return this.on(event, wrapped);
  }

  addListener(event: string, listener: Listener): this {
    return this.on(event, listener);
  }

  off(event: string, listener: Listener): this {
    this.#listeners.get(event)?.delete(listener);
    return this;
  }

  removeListener(event: string, listener: Listener): this {
    return this.off(event, listener);
  }

  emit(event: string, ...args: unknown[]): boolean {
    const set = this.#listeners.get(event);
    if (!set || set.size === 0) return false;
    for (const listener of [...set]) listener(...args);
    return true;
  }
}

/** A readable side of a child process: `on("data")`/`on("end")`, which is what streaming consumers use. */
export type ChildStream = Emitter;

/** The `ChildProcess` subset this bridge provides (spec §5.13: "streams stdout/stderr events"). */
export interface BridgedChildProcess extends Emitter {
  stdout: ChildStream;
  stderr: ChildStream;
  kill(): void;
}

class ChildProcessHandle extends Emitter implements BridgedChildProcess {
  readonly stdout: ChildStream = new Emitter();
  readonly stderr: ChildStream = new Emitter();
  #killed = false;
  /**
   * One **streaming** decoder per stream, for the whole life of the child.
   *
   * Main forwards raw byte chunks at whatever boundary Node's stream produced them (in practice the 64 KiB
   * high-water mark), so a UTF-8 code point routinely straddles two chunks. Decoding each chunk with a fresh,
   * non-streaming `TextDecoder` turned such a character into two U+FFFD replacement characters -- silently, and
   * invisibly from inside the tab. A streaming decoder carries the partial sequence across the boundary instead,
   * which is exactly what Node's own `setEncoding("utf8")` uses a `StringDecoder` for.
   *
   * `decodeBody` is left alone: it also serves one-shot callers (`fs.readFile`) that decode one complete body,
   * where a fresh decoder is correct.
   */
  readonly #decoders: Record<"stdout" | "stderr", TextDecoder> = {
    stdout: new TextDecoder(),
    stderr: new TextDecoder(),
  };

  constructor(private readonly onKill: () => void) {
    super();
  }

  /** Decodes one base64 chunk, holding back a partial trailing sequence for the next chunk to complete. */
  decodeChunk(stream: "stdout" | "stderr", base64: string): string {
    return this.#decoders[stream].decode(decodeBase64(base64), { stream: true });
  }

  /** Flushes whatever bytes are still held back when the child exits; a truly truncated sequence becomes U+FFFD. */
  flushStream(stream: "stdout" | "stderr"): string {
    return this.#decoders[stream].decode();
  }

  kill(): void {
    if (this.#killed) return;
    this.#killed = true;
    this.onKill();
  }
}

export interface FsPromisesModule {
  readFile(path: string, options?: unknown): Promise<string | Uint8Array>;
  writeFile(path: string, data: unknown, options?: unknown): Promise<void>;
  appendFile(path: string, data: unknown, options?: unknown): Promise<void>;
  readdir(path: string, options?: unknown): Promise<string[]>;
  mkdir(path: string, options?: unknown): Promise<void>;
  rm(path: string, options?: unknown): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  copyFile(from: string, to: string): Promise<void>;
  stat(path: string): Promise<FileStat>;
  access(path: string): Promise<void>;
}

/** What Main reports about one path. Methods, not bare booleans, so `stat(...).isDirectory()` reads like Node's. */
export interface FileStat {
  size: number;
  mtimeMs: number;
  isFile(): boolean;
  isDirectory(): boolean;
}

export interface NodeBridgeClient {
  fsPromises: FsPromisesModule;
  /** Callback-style `fs.*`, plus `fs.promises`, plus every `*Sync` name as a refusal. */
  fs: Record<string, unknown>;
  childProcess: Record<string, unknown>;
}

/** The async `fs` surface this bridge forwards. Every one is path-scoped and validated on Main's side. */
export const FS_ASYNC_METHODS = [
  "readFile",
  "writeFile",
  "appendFile",
  "readdir",
  "mkdir",
  "rm",
  "rename",
  "copyFile",
  "stat",
  "access",
] as const;

/**
 * The `fs.*Sync` names refused by §5.13. Listed explicitly rather than derived from `FS_ASYNC_METHODS`, because the
 * refusal has to fire for names this bridge has no async form of either (`readdirSync` has one, `openSync` does
 * not) -- a user who reaches for one must get the named error, not `undefined`.
 */
export const FS_SYNC_METHODS = [
  "readFileSync",
  "writeFileSync",
  "appendFileSync",
  "readdirSync",
  "mkdirSync",
  "rmSync",
  "renameSync",
  "copyFileSync",
  "statSync",
  "accessSync",
  "existsSync",
  "openSync",
  "closeSync",
  "readSync",
  "writeSync",
  "unlinkSync",
  "rmdirSync",
  "realpathSync",
  "lstatSync",
] as const;

export const CHILD_PROCESS_SYNC_METHODS = ["execSync", "execFileSync", "spawnSync"] as const;

/** The §5.13 modules with no implementation here at all; importing one is fine, touching it throws. */
export const UNSUPPORTED_MODULES = ["http", "net", "tls", "dgram", "worker_threads", "vm"] as const;

/**
 * The named exports each throw-only module publishes, every one of them a refusal.
 *
 * Needed because a named import has to bind to something at **build** time. Measured across four module shapes
 * (see the Task 11 report): a CommonJS module whose `module.exports` is a `Proxy` serves `import http from "http"`
 * correctly but binds `import { createServer } from "http"` to `undefined`, so the call fails with a bare
 * `TypeError` instead of the spec's refusal -- Bun does not turn that named import into a property read, contrary
 * to what the vendor-stub note in `resolve-plugin.ts` suggests for plain objects. An ES module that throws at top
 * level fails the build outright. An ES module with explicit named throwers is the one shape where the named form
 * throws `JSLabUnsupportedError` *when called*, the default form still refuses on any property, and an unused
 * import stays harmless.
 *
 * A curated surface, not an exhaustive one: these are the names real code imports. A name not listed here fails
 * the build with "no matching export", which still names the specifier -- worse than the refusal, but rare, and
 * never silent.
 */
export const UNSUPPORTED_MODULE_EXPORTS: Record<string, readonly string[]> = {
  http: [
    "createServer",
    "request",
    "get",
    "Agent",
    "Server",
    "IncomingMessage",
    "ServerResponse",
    "STATUS_CODES",
    "METHODS",
  ],
  net: ["createServer", "connect", "createConnection", "Socket", "Server", "isIP", "isIPv4", "isIPv6"],
  tls: ["connect", "createServer", "createSecureContext", "TLSSocket", "Server", "checkServerIdentity"],
  dgram: ["createSocket", "Socket"],
  worker_threads: ["Worker", "isMainThread", "parentPort", "workerData", "threadId", "MessageChannel", "MessagePort"],
  vm: [
    "runInNewContext",
    "runInThisContext",
    "runInContext",
    "createContext",
    "compileFunction",
    "Script",
    "isContext",
  ],
};

/**
 * Builds a module object for one of `UNSUPPORTED_MODULES`: every property access throws the switch-to-Bun refusal.
 *
 * A `Proxy` rather than an object of thrower functions, so that a *property read* fails as loudly as a call does --
 * `const { createServer } = require("http")` must not hand back `undefined` and fail somewhere else later. The
 * interop allowlist exists because a bundler's own CommonJS/ESM interop reads these keys off a namespace before any
 * user code runs; throwing on those would turn an unused `import` into a build-time or evaluation-time crash,
 * whereas §5.13 asks for a refusal when the module is *used*.
 */
export function createUnsupportedModule(moduleName: string): Record<string, never> {
  const refuse = (): never => {
    throw new JSLabUnsupportedError(unsupportedModuleMessage(moduleName));
  };
  const interop = new Set(["__esModule", "default", "then", "constructor", "prototype"]);
  return new Proxy(Object.create(null) as Record<string, never>, {
    get(_target, key) {
      if (typeof key === "symbol" || interop.has(key)) return undefined;
      return refuse();
    },
    apply: refuse,
    construct: refuse,
  });
}

/**
 * Builds one tab's Node bridge client over `transport`. Pure with respect to the page: it installs nothing and
 * reads no global, so `bun test` drives it against a fake transport exactly the way `fetch-proxy.test.ts` does.
 */
export function createNodeBridge(options: { transport: NodeTransport }): NodeBridgeClient {
  const { transport } = options;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  const children = new Map<number, ChildProcessHandle>();
  let nextId = 1;

  transport.onEvent((event) => {
    const child = children.get(event.id);
    switch (event.type) {
      case "result": {
        pending.get(event.id)?.resolve(event.value);
        pending.delete(event.id);
        return;
      }
      case "error": {
        const error = hostError(event);
        const entry = pending.get(event.id);
        pending.delete(event.id);
        if (entry) entry.reject(error);
        // A failure that arrives for a running child is reported on the child, not thrown into nothing.
        if (child) {
          children.delete(event.id);
          child.emit("error", error);
        }
        return;
      }
      case "stdout":
        if (child) child.stdout.emit("data", child.decodeChunk("stdout", event.data));
        return;
      case "stderr":
        if (child) child.stderr.emit("data", child.decodeChunk("stderr", event.data));
        return;
      case "exit": {
        if (!child) return;
        children.delete(event.id);
        // Anything the streaming decoders were still holding back belongs to the consumer before the stream ends.
        const tailOut = child.flushStream("stdout");
        if (tailOut) child.stdout.emit("data", tailOut);
        const tailErr = child.flushStream("stderr");
        if (tailErr) child.stderr.emit("data", tailErr);
        child.stdout.emit("end");
        child.stderr.emit("end");
        child.emit("exit", event.code, event.signal);
        child.emit("close", event.code, event.signal);
        return;
      }
    }
  });

  function call(module: NodeCallRequest["module"], method: string, args: unknown[]): Promise<unknown> {
    const id = nextId;
    nextId += 1;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      transport.call(id, { module, method, args });
    });
  }

  const toStat = (value: unknown): FileStat => {
    const raw = (value ?? {}) as { size?: number; mtimeMs?: number; isFile?: boolean; isDirectory?: boolean };
    return {
      size: raw.size ?? 0,
      mtimeMs: raw.mtimeMs ?? 0,
      isFile: () => raw.isFile === true,
      isDirectory: () => raw.isDirectory === true,
    };
  };

  const fsPromises: FsPromisesModule = {
    async readFile(path, options) {
      const body = await call("fs", "readFile", [path]);
      return decodeBody(String(body), encodingOf(options));
    },
    async writeFile(path, data, options) {
      await call("fs", "writeFile", [path, encodeBody(data, encodingOf(options))]);
    },
    async appendFile(path, data, options) {
      await call("fs", "appendFile", [path, encodeBody(data, encodingOf(options))]);
    },
    async readdir(path) {
      return (await call("fs", "readdir", [path])) as string[];
    },
    async mkdir(path, options) {
      await call("fs", "mkdir", [
        path,
        { recursive: (options as { recursive?: boolean } | undefined)?.recursive === true },
      ]);
    },
    async rm(path, options) {
      const opts = (options ?? {}) as { recursive?: boolean; force?: boolean };
      await call("fs", "rm", [path, { recursive: opts.recursive === true, force: opts.force === true }]);
    },
    async rename(from, to) {
      await call("fs", "rename", [from, to]);
    },
    async copyFile(from, to) {
      await call("fs", "copyFile", [from, to]);
    },
    async stat(path) {
      return toStat(await call("fs", "stat", [path]));
    },
    async access(path) {
      await call("fs", "access", [path]);
    },
  };

  /**
   * Node's callback convention: the last argument is `(error, value)`, and anything before it is the options the
   * promise form takes. Errors are delivered to the callback, never thrown asynchronously -- a rejected promise
   * with no handler would surface as an unhandled rejection and take the run's error channel with it.
   */
  const fs: Record<string, unknown> = { promises: fsPromises };
  for (const method of FS_ASYNC_METHODS) {
    fs[method] = (...args: unknown[]): void => {
      const callback = args[args.length - 1];
      if (typeof callback !== "function") {
        throw new TypeError(`fs.${method} requires a callback in the "Browser & Node APIs" runtime`);
      }
      const rest = args.slice(0, -1) as [string, ...unknown[]];
      const done = callback as (error: Error | null, value?: unknown) => void;
      (fsPromises[method] as (...a: unknown[]) => Promise<unknown>)(...rest).then(
        (value) => done(null, value),
        (error: unknown) => done(error instanceof Error ? error : new Error(String(error))),
      );
    };
  }
  for (const method of FS_SYNC_METHODS) {
    fs[method] = (): never => throwUnsupportedSync(`fs.${method}`, FS_SYNC_ALTERNATIVE);
  }

  /** Starts one child process and wires its streamed output to a `ChildProcess`-shaped handle. */
  function startChild(method: "exec" | "execFile" | "spawn", args: unknown[]): ChildProcessHandle {
    const id = nextId;
    nextId += 1;
    const child = new ChildProcessHandle(() => transport.abort(id));
    children.set(id, child);
    // Normalized to a fixed arity here rather than on Main's side, so the wire shape is an exact tuple the schema
    // can validate outright (`webNodeChildProcessCallSchema`) instead of an open `unknown[]`. The options object is
    // always sent, empty when the caller passed none, so the tuple stays fixed-length.
    //
    // `cwd`, `env` and `shell` are forwarded rather than dropped: `exec(cmd, { cwd })` is ordinary Node, and Main
    // honours them (see `web-node-handlers.ts`). An earlier draft dropped them to protect a working-directory
    // confinement that has since been removed for breaking parity with the Bun runtime.
    const options = args.find((argument, index) => index > 0 && isOptionsObject(argument)) ?? {};
    const normalized =
      method === "exec"
        ? [String(args[0]), options]
        : [String(args[0]), Array.isArray(args[1]) ? (args[1] as unknown[]).map(String) : [], options];
    transport.call(id, { module: "child_process", method, args: normalized });
    return child;
  }

  /**
   * `exec`/`execFile` keep Node's dual shape: they return the child *and* call back with the accumulated output.
   * The buffers below are the reason redaction must never touch stream payloads -- this is the exact text the
   * caller's own callback receives, so altering it would corrupt the program's data (see the Main-side module).
   */
  function execLike(method: "exec" | "execFile", args: unknown[]): BridgedChildProcess {
    const callback = typeof args[args.length - 1] === "function" ? args[args.length - 1] : null;
    const forwarded = callback ? args.slice(0, -1) : args;
    const child = startChild(method, forwarded);
    if (!callback) return child;
    const done = callback as (error: Error | null, stdout: string, stderr: string) => void;
    let stdout = "";
    let stderr = "";
    let settled = false;
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      done(error as Error, stdout, stderr);
    });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      if (code === 0 || code === null) {
        done(null, stdout, stderr);
        return;
      }
      const error = new Error(`Command failed with exit code ${String(code)}`) as Error & { code?: number };
      error.code = code as number;
      done(error, stdout, stderr);
    });
    return child;
  }

  const childProcess: Record<string, unknown> = {
    exec: (...args: unknown[]) => execLike("exec", args),
    execFile: (...args: unknown[]) => execLike("execFile", args),
    spawn: (...args: unknown[]) => startChild("spawn", args),
  };
  for (const method of CHILD_PROCESS_SYNC_METHODS) {
    childProcess[method] = (): never =>
      throwUnsupportedSync(`child_process.${method}`, childProcessSyncAlternative(method));
  }

  return { fsPromises, fs, childProcess };
}

/** The one global this module installs onto; a real page, or a fake built for tests. */
export interface NodeBridgeGlobal {
  [key: string]: unknown;
}

/**
 * Installs the bridge client on the page global for a `browser-node` tab, and returns whether it installed
 * anything. A no-op for `browser`, exactly like `installFetchProxy` -- a `browser` tab has no Node builtins at all
 * (the bundler refuses them outright, `polyfill-plugin.ts`), so there is nothing there to serve.
 *
 * Left reconfigurable, unlike `__jl`: this global is read *by* the tab's own bundled modules rather than being the
 * channel JSLab reports through, so a run that replaces it only breaks its own `fs` calls. Making it
 * non-configurable would also stop a second `startRunnerWeb` against one global, which several tests do.
 */
export function installNodeBridge(options: {
  runtime: "browser" | "browser-node";
  transport: NodeTransport;
  global?: NodeBridgeGlobal;
}): boolean {
  if (options.runtime === "browser") return false;
  const g = options.global ?? (globalThis as unknown as NodeBridgeGlobal);
  Object.defineProperty(g, NODE_BRIDGE_GLOBAL, {
    enumerable: false,
    configurable: true,
    writable: true,
    value: createNodeBridge({ transport: options.transport }),
  });
  return true;
}

/**
 * Reads the installed client back. Called by the module sources `polyfill-plugin.ts` generates, which are evaluated
 * inside the tab's bundle -- a different script from the bootstrap that installed it, in the same realm.
 *
 * The failure is a `JSLabUnsupportedError` rather than a bare `TypeError` because the only way to reach it is to
 * import `fs` in a page whose bridge was never installed, which is the same user-facing situation as the rest of
 * this module: a Node API that is not available in this runtime.
 */
export function requireNodeBridge(): NodeBridgeClient {
  const bridge = (globalThis as unknown as NodeBridgeGlobal)[NODE_BRIDGE_GLOBAL];
  if (!bridge) throw new JSLabUnsupportedError(NODE_BRIDGE_MISSING_MESSAGE);
  return bridge as NodeBridgeClient;
}
