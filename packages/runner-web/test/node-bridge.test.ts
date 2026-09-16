import { describe, expect, test } from "bun:test";
import {
  CHILD_PROCESS_SYNC_METHODS,
  createNodeBridge,
  createUnsupportedModule,
  FS_SYNC_METHODS,
  installNodeBridge,
  type NodeBridgeGlobal,
  type NodeCallRequest,
  type NodeHostEvent,
  type NodeTransport,
  UNSUPPORTED_MODULES,
} from "../src/node-bridge";

// bun:test has no page and no host: the transport is a fake the test drives by hand, exactly the approach
// fetch-proxy.test.ts takes. Every assertion here is about the bridge's own behaviour, not about a real webview.

function fakeTransport() {
  const calls: { id: number; request: NodeCallRequest }[] = [];
  const aborted: number[] = [];
  const listeners = new Set<(event: NodeHostEvent) => void>();
  const transport: NodeTransport = {
    call(id, request) {
      calls.push({ id, request });
    },
    abort(id) {
      aborted.push(id);
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    transport,
    calls,
    aborted,
    deliver(event: NodeHostEvent) {
      for (const listener of [...listeners]) listener(event);
    },
    lastId(): number {
      return calls[calls.length - 1]?.id ?? 0;
    },
  };
}

const b64 = (text: string) => btoa(text);

describe("the sync refusals (spec §5.13)", () => {
  // The exact sentence the spec table quotes, character for character. This is the assertion that would have
  // caught Task 11 never shipping: before it, `fs.readFileSync` was simply absent.
  test("fs.readFileSync throws the spec's message verbatim, as a JSLabUnsupportedError", () => {
    const host = fakeTransport();
    const bridge = createNodeBridge({ transport: host.transport });
    const readFileSync = bridge.fs.readFileSync as () => never;

    expect(readFileSync).toThrow(
      'fs.readFileSync isn\'t available in "Browser & Node APIs". Use fs/promises or switch this tab to the Bun runtime.',
    );
    try {
      readFileSync();
      throw new Error("did not throw");
    } catch (error) {
      expect((error as Error).name).toBe("JSLabUnsupportedError");
      // `String(error)` is what a user sees in the output pane, and it must read exactly like the spec line.
      expect(String(error)).toBe(
        'JSLabUnsupportedError: fs.readFileSync isn\'t available in "Browser & Node APIs". Use fs/promises or switch this tab to the Bun runtime.',
      );
    }
  });

  test("every fs.*Sync name refuses with its own method name substituted", () => {
    const host = fakeTransport();
    const bridge = createNodeBridge({ transport: host.transport });
    for (const method of FS_SYNC_METHODS) {
      const fn = bridge.fs[method] as () => never;
      expect(fn).toThrow(
        `fs.${method} isn't available in "Browser & Node APIs". Use fs/promises or switch this tab to the Bun runtime.`,
      );
    }
  });

  test("child_process.*Sync refuses the same way", () => {
    const host = fakeTransport();
    const bridge = createNodeBridge({ transport: host.transport });
    for (const method of CHILD_PROCESS_SYNC_METHODS) {
      const fn = bridge.childProcess[method] as () => never;
      expect(fn).toThrow(
        `child_process.${method} isn't available in "Browser & Node APIs". Use child_process.${method.replace(
          /Sync$/,
          "",
        )} or switch this tab to the Bun runtime.`,
      );
    }
  });
});

describe("the throw-only modules (spec §5.13)", () => {
  test("every one refuses on a property read, with the switch-to-Bun hint", () => {
    for (const moduleName of UNSUPPORTED_MODULES) {
      const module = createUnsupportedModule(moduleName) as unknown as Record<string, unknown>;
      // A read, not a call: destructuring must fail loudly rather than hand back `undefined`.
      expect(() => module.createServer).toThrow(
        `${moduleName} isn't available in "Browser & Node APIs". Switch this tab to the Bun runtime.`,
      );
      try {
        void module.anything;
        throw new Error("did not throw");
      } catch (error) {
        expect((error as Error).name).toBe("JSLabUnsupportedError");
      }
    }
  });

  // Merely importing an unused module must stay harmless: a bundler's interop reads these keys off the namespace
  // before any user code runs, so throwing on them would turn an unused import into an evaluation-time crash.
  test("bundler interop keys read back as undefined instead of throwing", () => {
    const module = createUnsupportedModule("http") as unknown as Record<string, unknown>;
    expect(module.__esModule).toBeUndefined();
    expect(module.default).toBeUndefined();
    expect(module.then).toBeUndefined();
  });
});

describe("fs/promises over the bridge", () => {
  test("readFile sends one call and decodes the reply as text", async () => {
    const host = fakeTransport();
    const bridge = createNodeBridge({ transport: host.transport });

    const pending = bridge.fsPromises.readFile("notes.txt", "utf8");
    expect(host.calls[0]?.request).toEqual({ module: "fs", method: "readFile", args: ["notes.txt"] });
    host.deliver({ type: "result", id: host.lastId(), value: b64("hello world") });
    expect(await pending).toBe("hello world");
  });

  // The correctness half of the redaction rule, proved from the page's side: whatever Main sends back is decoded
  // byte for byte, with nothing inspecting or rewriting it on the way through.
  test("a file body that looks like a credential is decoded byte-identically", async () => {
    const host = fakeTransport();
    const bridge = createNodeBridge({ transport: host.transport });
    const body = "AUTHORIZATION=Bearer ghp_0123456789abcdefghijklmnopqr\nAPI_KEY=sk-abcdefghijklmnopqrstuvwx\n";

    const pending = bridge.fsPromises.readFile("secrets.env", "utf8");
    host.deliver({ type: "result", id: host.lastId(), value: b64(body) });
    expect(await pending).toBe(body);
  });

  test("readFile with no encoding returns the raw bytes", async () => {
    const host = fakeTransport();
    const bridge = createNodeBridge({ transport: host.transport });
    const pending = bridge.fsPromises.readFile("blob.bin");
    host.deliver({ type: "result", id: host.lastId(), value: btoa("\x00\x01\xfe") });
    const bytes = (await pending) as Uint8Array;
    expect(Array.from(bytes)).toEqual([0, 1, 254]);
  });

  test("writeFile sends the body base64-encoded", async () => {
    const host = fakeTransport();
    const bridge = createNodeBridge({ transport: host.transport });
    const pending = bridge.fsPromises.writeFile("out.txt", "hi");
    expect(host.calls[0]?.request.args).toEqual(["out.txt", b64("hi")]);
    host.deliver({ type: "result", id: host.lastId(), value: null });
    await pending;
  });

  test("a host-reported failure rejects with the original name and code", async () => {
    const host = fakeTransport();
    const bridge = createNodeBridge({ transport: host.transport });
    const pending = bridge.fsPromises.readFile("missing.txt");
    host.deliver({
      type: "error",
      id: host.lastId(),
      name: "Error",
      message: "ENOENT: no such file or directory",
      code: "ENOENT",
    });
    await expect(pending).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("stat comes back with Node-shaped isFile/isDirectory methods", async () => {
    const host = fakeTransport();
    const bridge = createNodeBridge({ transport: host.transport });
    const pending = bridge.fsPromises.stat("dir");
    host.deliver({
      type: "result",
      id: host.lastId(),
      value: { size: 4, mtimeMs: 1, isFile: false, isDirectory: true },
    });
    const stats = await pending;
    expect(stats.isDirectory()).toBe(true);
    expect(stats.isFile()).toBe(false);
    expect(stats.size).toBe(4);
  });
});

describe("callback-style fs (spec §5.13)", () => {
  test("the callback receives the value, Node-style", async () => {
    const host = fakeTransport();
    const bridge = createNodeBridge({ transport: host.transport });
    const readFile = bridge.fs.readFile as (path: string, cb: (e: Error | null, v?: unknown) => void) => void;

    const seen: unknown[] = [];
    readFile("notes.txt", (error, value) => seen.push([error, value]));
    host.deliver({ type: "result", id: host.lastId(), value: b64("from callback") });
    await Bun.sleep(1);
    expect(seen).toEqual([[null, new Uint8Array(new TextEncoder().encode("from callback"))]]);
  });

  // A rejected promise with no handler would surface as an unhandled rejection and take the run's error channel
  // with it, so a failure has to reach the callback instead.
  test("a failure reaches the callback rather than becoming an unhandled rejection", async () => {
    const host = fakeTransport();
    const bridge = createNodeBridge({ transport: host.transport });
    const readFile = bridge.fs.readFile as (path: string, cb: (e: Error | null, v?: unknown) => void) => void;

    let received: Error | null = null;
    readFile("missing.txt", (error) => {
      received = error;
    });
    host.deliver({ type: "error", id: host.lastId(), name: "Error", message: "ENOENT", code: "ENOENT" });
    await Bun.sleep(1);
    expect(received).toMatchObject({ message: "ENOENT" });
  });

  test("fs.promises is the same async surface", async () => {
    const host = fakeTransport();
    const bridge = createNodeBridge({ transport: host.transport });
    const promises = bridge.fs.promises as { readFile(path: string, enc: string): Promise<string> };
    const pending = promises.readFile("a.txt", "utf8");
    host.deliver({ type: "result", id: host.lastId(), value: b64("via fs.promises") });
    expect(await pending).toBe("via fs.promises");
  });
});

describe("child_process over the bridge (spec §5.13)", () => {
  test("spawn streams stdout and stderr, then reports exit and close", async () => {
    const host = fakeTransport();
    const bridge = createNodeBridge({ transport: host.transport });
    const spawn = bridge.childProcess.spawn as (file: string, args: string[]) => Record<string, never>;

    const child = spawn("git", ["status"]) as unknown as {
      stdout: { on(e: string, cb: (chunk: unknown) => void): void };
      stderr: { on(e: string, cb: (chunk: unknown) => void): void };
      on(e: string, cb: (...a: unknown[]) => void): void;
    };
    // Normalized to a fixed arity on the way out, so Main's schema can validate an exact tuple.
    expect(host.calls[0]?.request).toEqual({
      module: "child_process",
      method: "spawn",
      args: ["git", ["status"], {}],
    });

    const out: string[] = [];
    const err: string[] = [];
    const exits: unknown[] = [];
    child.stdout.on("data", (chunk) => out.push(String(chunk)));
    child.stderr.on("data", (chunk) => err.push(String(chunk)));
    child.on("exit", (code) => exits.push(code));

    const id = host.lastId();
    host.deliver({ type: "stdout", id, data: b64("on branch main") });
    host.deliver({ type: "stderr", id, data: b64("a warning") });
    host.deliver({ type: "exit", id, code: 0, signal: null });

    expect(out).toEqual(["on branch main"]);
    expect(err).toEqual(["a warning"]);
    expect(exits).toEqual([0]);
  });

  // The other half of the redaction rule: a process's own output is the program's data, so it arrives exactly as
  // the process wrote it even when it looks exactly like a credential.
  test("stdout carrying a credential-shaped token arrives unchanged", async () => {
    const host = fakeTransport();
    const bridge = createNodeBridge({ transport: host.transport });
    const spawn = bridge.childProcess.spawn as (file: string, args: string[]) => unknown;
    const child = spawn("printf", ["%s", "ghp_0123456789abcdefghijklmnopqr"]) as {
      stdout: { on(e: string, cb: (chunk: unknown) => void): void };
    };
    const out: string[] = [];
    child.stdout.on("data", (chunk) => out.push(String(chunk)));
    host.deliver({ type: "stdout", id: host.lastId(), data: b64("ghp_0123456789abcdefghijklmnopqr") });
    expect(out).toEqual(["ghp_0123456789abcdefghijklmnopqr"]);
  });

  test("exec accumulates output and calls back Node-style on success", async () => {
    const host = fakeTransport();
    const bridge = createNodeBridge({ transport: host.transport });
    const exec = bridge.childProcess.exec as (cmd: string, cb: (e: Error | null, o: string, s: string) => void) => void;

    // Collected into an array rather than a `let`: TypeScript narrows a `let` initialized to `null` back to `null`
    // at the assertion, since it cannot see the callback run.
    const results: [Error | null, string, string][] = [];
    exec("echo hi", (error, stdout, stderr) => results.push([error, stdout, stderr]));
    expect(host.calls[0]?.request.args).toEqual(["echo hi", {}]);
    const id = host.lastId();
    host.deliver({ type: "stdout", id, data: b64("hi") });
    host.deliver({ type: "stdout", id, data: b64("!") });
    host.deliver({ type: "exit", id, code: 0, signal: null });
    expect(results).toEqual([[null, "hi!", ""]]);
  });

  test("a non-zero exit is an error for exec's callback, with the output still delivered", async () => {
    const host = fakeTransport();
    const bridge = createNodeBridge({ transport: host.transport });
    const exec = bridge.childProcess.exec as (cmd: string, cb: (e: Error | null, o: string, s: string) => void) => void;

    const results: [Error | null, string, string][] = [];
    exec("false", (error, stdout, stderr) => results.push([error, stdout, stderr]));
    const id = host.lastId();
    host.deliver({ type: "stderr", id, data: b64("boom") });
    host.deliver({ type: "exit", id, code: 2, signal: null });
    expect(results[0]?.[0]).toMatchObject({ message: "Command failed with exit code 2" });
    expect(results[0]?.[2]).toBe("boom");
  });

  /**
   * `exec(cmd, { cwd })` is ordinary Node, and Main honours `cwd`, `env` and `shell`. An earlier draft dropped them
   * here to protect a working-directory confinement that has since been removed for breaking parity with `bun`, so
   * this pins that they really do reach the host.
   */
  test("cwd, env and shell are forwarded to the host rather than dropped", () => {
    const host = fakeTransport();
    const bridge = createNodeBridge({ transport: host.transport });
    const exec = bridge.childProcess.exec as (cmd: string, options: unknown) => unknown;
    const spawn = bridge.childProcess.spawn as (file: string, args: string[], options: unknown) => unknown;

    exec("ls", { cwd: "nested", env: { A: "1" }, shell: "/bin/zsh" });
    expect(host.calls[0]?.request.args).toEqual(["ls", { cwd: "nested", env: { A: "1" }, shell: "/bin/zsh" }]);

    spawn("git", ["status"], { cwd: "sub" });
    expect(host.calls[1]?.request.args).toEqual(["git", ["status"], { cwd: "sub" }]);
  });

  // Fixed arity is what lets Main's schema validate an exact tuple rather than an open array.
  test("a call with no options still sends an empty options object", () => {
    const host = fakeTransport();
    const bridge = createNodeBridge({ transport: host.transport });
    (bridge.childProcess.spawn as (file: string, args: string[]) => unknown)("git", ["status"]);
    expect(host.calls[0]?.request.args).toEqual(["git", ["status"], {}]);
  });

  test("kill() asks the host to abandon the call", () => {
    const host = fakeTransport();
    const bridge = createNodeBridge({ transport: host.transport });
    const spawn = bridge.childProcess.spawn as (file: string, args: string[]) => { kill(): void };
    const child = spawn("sleep", ["60"]);
    child.kill();
    expect(host.aborted).toEqual([host.lastId()]);
  });
});

describe("installNodeBridge", () => {
  // Mirrors installFetchProxy's own first test: `browser` is CORS-enforced, Node-free, and gets nothing at all.
  test("the browser runtime installs nothing", () => {
    const host = fakeTransport();
    const g: NodeBridgeGlobal = {};
    expect(installNodeBridge({ runtime: "browser", transport: host.transport, global: g })).toBe(false);
    expect(g.__jslabNodeBridge).toBeUndefined();
  });

  test("browser-node installs a client the bundled modules can read back", () => {
    const host = fakeTransport();
    const g: NodeBridgeGlobal = {};
    expect(installNodeBridge({ runtime: "browser-node", transport: host.transport, global: g })).toBe(true);
    const bridge = g.__jslabNodeBridge as { fs: Record<string, unknown> };
    expect(typeof bridge.fs.readFile).toBe("function");
    expect(bridge.fs.readFileSync).toThrow("Use fs/promises or switch this tab to the Bun runtime.");
  });
});
