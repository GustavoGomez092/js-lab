import { describe, expect, test } from "bun:test";
import {
  webNodeAbortSchema,
  webNodeCallSchema,
  webNodeChildProcessCallSchema,
  webNodeFsCallSchema,
} from "../src/web-node";

/**
 * Final review, finding F: the negative half of the `browser-node` Node bridge's validation.
 *
 * These four schemas are the **sole** validation layer between an untrusted `browser-node` page and Main's
 * filesystem and process access (`apps/desktop/src/main/rpc/web-node-handlers.ts` parses every bridged call through
 * `webNodeCallSchema` before acting on it). They carry real logic -- a control-character refusal on paths,
 * fixed-arity tuples per method, argv/env size bounds -- and had no test coverage anywhere in the repo:
 * `web-node-handlers.test.ts` is thorough on filesystem *parity* but only ever feeds it well-formed calls.
 *
 * A future edit that loosened `filePath`'s regex, dropped a `.max()` bound or removed a method from one of the
 * discriminated unions would compile cleanly -- TypeScript cannot check a regex or a bound -- and every existing
 * suite would stay green while the boundary silently weakened. These are the tests that make it hold, so each
 * group pairs its refusals with a positive control proving the schema accepts the legitimate shape.
 */

/**
 * Control characters built programmatically, never written as escapes in a string literal: the formatter
 * rewrites an escape like the NUL one into the raw byte, which would leave invisible control characters in
 * this file. Building them here keeps the source readable and stable across a format.
 */
const NUL = String.fromCharCode(0);
const UNIT_SEPARATOR = String.fromCharCode(0x1f);

const ok = (schema: { safeParse(v: unknown): { success: boolean } }, value: unknown) => schema.safeParse(value).success;

describe("webNodeFsCallSchema", () => {
  test("accepts each well-formed fs call (the positive control for every refusal below)", () => {
    expect(ok(webNodeFsCallSchema, { method: "readFile", args: ["/tmp/notes.txt"] })).toBe(true);
    expect(ok(webNodeFsCallSchema, { method: "writeFile", args: ["/tmp/notes.txt", "aGk="] })).toBe(true);
    expect(ok(webNodeFsCallSchema, { method: "mkdir", args: ["/tmp/d", { recursive: true }] })).toBe(true);
    expect(ok(webNodeFsCallSchema, { method: "rm", args: ["/tmp/d", { recursive: true, force: false }] })).toBe(true);
    expect(ok(webNodeFsCallSchema, { method: "rename", args: ["/tmp/a", "/tmp/b"] })).toBe(true);
  });

  test("refuses a method it does not implement", () => {
    // `chmod`/`symlink`/`open` are not bridged at all; a page naming one must be refused, not waved through.
    expect(ok(webNodeFsCallSchema, { method: "chmod", args: ["/tmp/a"] })).toBe(false);
    expect(ok(webNodeFsCallSchema, { method: "symlink", args: ["/tmp/a", "/tmp/b"] })).toBe(false);
    expect(ok(webNodeFsCallSchema, { method: "readFileSync", args: ["/tmp/a"] })).toBe(false);
    expect(ok(webNodeFsCallSchema, { method: "__proto__", args: ["/tmp/a"] })).toBe(false);
  });

  /**
   * The load-bearing path refusal. A NUL can truncate a path inside a syscall, so a path carrying one is never
   * legitimate however it is later resolved -- `/etc/passwd\0.txt` must not reach `resolvePath`.
   */
  test("refuses a path carrying NUL or any other control character", () => {
    expect(ok(webNodeFsCallSchema, { method: "readFile", args: [`/etc/passwd${NUL}.txt`] })).toBe(false);
    expect(ok(webNodeFsCallSchema, { method: "readFile", args: ["/tmp/a\nb"] })).toBe(false);
    expect(ok(webNodeFsCallSchema, { method: "readFile", args: ["/tmp/a\tb"] })).toBe(false);
    expect(ok(webNodeFsCallSchema, { method: "readFile", args: [UNIT_SEPARATOR] })).toBe(false);
    // Both path slots of a two-path call are held to it, not just the first.
    expect(ok(webNodeFsCallSchema, { method: "rename", args: ["/tmp/a", `/tmp/b${NUL}`] })).toBe(false);
    expect(ok(webNodeFsCallSchema, { method: "copyFile", args: [`/tmp/a${NUL}`, "/tmp/b"] })).toBe(false);
  });

  test("refuses an empty or over-long path", () => {
    expect(ok(webNodeFsCallSchema, { method: "readFile", args: [""] })).toBe(false);
    expect(ok(webNodeFsCallSchema, { method: "readFile", args: ["a".repeat(4096)] })).toBe(true);
    expect(ok(webNodeFsCallSchema, { method: "readFile", args: ["a".repeat(4097)] })).toBe(false);
  });

  test("refuses a path that is not a string", () => {
    expect(ok(webNodeFsCallSchema, { method: "readFile", args: [42] })).toBe(false);
    expect(ok(webNodeFsCallSchema, { method: "readFile", args: [null] })).toBe(false);
    expect(ok(webNodeFsCallSchema, { method: "readFile", args: [{ toString: "/tmp/a" }] })).toBe(false);
    expect(ok(webNodeFsCallSchema, { method: "readFile", args: [["/tmp/a"]] })).toBe(false);
  });

  /** Fixed-arity tuples are the whole point of the discriminated union: an open `unknown[]` would validate nothing. */
  test("refuses the wrong number of arguments", () => {
    expect(ok(webNodeFsCallSchema, { method: "readFile", args: [] })).toBe(false);
    expect(ok(webNodeFsCallSchema, { method: "readFile", args: ["/tmp/a", "/tmp/b"] })).toBe(false);
    expect(ok(webNodeFsCallSchema, { method: "rename", args: ["/tmp/a"] })).toBe(false);
    expect(ok(webNodeFsCallSchema, { method: "writeFile", args: ["/tmp/a"] })).toBe(false);
    expect(ok(webNodeFsCallSchema, { method: "readFile", args: "not-an-array" })).toBe(false);
  });

  test("refuses a file body that is not a string", () => {
    expect(ok(webNodeFsCallSchema, { method: "writeFile", args: ["/tmp/a", 123] })).toBe(false);
    expect(ok(webNodeFsCallSchema, { method: "appendFile", args: ["/tmp/a", { data: "x" }] })).toBe(false);
  });

  test("refuses malformed mkdir/rm options", () => {
    // The options object is always sent by the page, so a missing or mistyped flag is a malformed call.
    expect(ok(webNodeFsCallSchema, { method: "mkdir", args: ["/tmp/d", {}] })).toBe(false);
    expect(ok(webNodeFsCallSchema, { method: "mkdir", args: ["/tmp/d", { recursive: "yes" }] })).toBe(false);
    expect(ok(webNodeFsCallSchema, { method: "rm", args: ["/tmp/d", { recursive: true }] })).toBe(false);
    expect(ok(webNodeFsCallSchema, { method: "rm", args: ["/tmp/d", { force: true }] })).toBe(false);
    expect(ok(webNodeFsCallSchema, { method: "mkdir", args: ["/tmp/d", null] })).toBe(false);
  });

  test("refuses a missing or non-string method", () => {
    expect(ok(webNodeFsCallSchema, { args: ["/tmp/a"] })).toBe(false);
    expect(ok(webNodeFsCallSchema, { method: 7, args: ["/tmp/a"] })).toBe(false);
    expect(ok(webNodeFsCallSchema, null)).toBe(false);
    expect(ok(webNodeFsCallSchema, "readFile")).toBe(false);
  });
});

describe("webNodeChildProcessCallSchema", () => {
  test("accepts each well-formed command call (the positive control)", () => {
    expect(ok(webNodeChildProcessCallSchema, { method: "exec", args: ["ls -la", {}] })).toBe(true);
    expect(ok(webNodeChildProcessCallSchema, { method: "execFile", args: ["git", ["status"], {}] })).toBe(true);
    expect(ok(webNodeChildProcessCallSchema, { method: "spawn", args: ["git", [], { cwd: "/tmp" }] })).toBe(true);
  });

  test("refuses a method it does not implement", () => {
    expect(ok(webNodeChildProcessCallSchema, { method: "execSync", args: ["ls", {}] })).toBe(false);
    expect(ok(webNodeChildProcessCallSchema, { method: "fork", args: ["a.js", [], {}] })).toBe(false);
  });

  test("refuses an empty or over-long command", () => {
    expect(ok(webNodeChildProcessCallSchema, { method: "exec", args: ["", {}] })).toBe(false);
    expect(ok(webNodeChildProcessCallSchema, { method: "exec", args: ["a".repeat(8192), {}] })).toBe(true);
    expect(ok(webNodeChildProcessCallSchema, { method: "exec", args: ["a".repeat(8193), {}] })).toBe(false);
    expect(ok(webNodeChildProcessCallSchema, { method: "spawn", args: ["", [], {}] })).toBe(false);
    expect(ok(webNodeChildProcessCallSchema, { method: "spawn", args: ["a".repeat(4097), [], {}] })).toBe(false);
  });

  test("refuses the wrong arity: exec takes a command line, execFile/spawn take a file plus an argv", () => {
    expect(ok(webNodeChildProcessCallSchema, { method: "exec", args: ["ls"] })).toBe(false);
    expect(ok(webNodeChildProcessCallSchema, { method: "exec", args: ["ls", [], {}] })).toBe(false);
    expect(ok(webNodeChildProcessCallSchema, { method: "spawn", args: ["git", {}] })).toBe(false);
    expect(ok(webNodeChildProcessCallSchema, { method: "execFile", args: ["git", ["status"]] })).toBe(false);
  });

  test("refuses an argv that is too long, or whose entries are oversized or not strings", () => {
    const argv = (n: number) => Array.from({ length: n }, () => "x");
    expect(ok(webNodeChildProcessCallSchema, { method: "spawn", args: ["git", argv(256), {}] })).toBe(true);
    expect(ok(webNodeChildProcessCallSchema, { method: "spawn", args: ["git", argv(257), {}] })).toBe(false);
    expect(ok(webNodeChildProcessCallSchema, { method: "spawn", args: ["git", ["a".repeat(4097)], {}] })).toBe(false);
    expect(ok(webNodeChildProcessCallSchema, { method: "spawn", args: ["git", [42], {}] })).toBe(false);
    expect(ok(webNodeChildProcessCallSchema, { method: "spawn", args: ["git", "status", {}] })).toBe(false);
  });

  test("refuses malformed command options", () => {
    const opts = (options: unknown) => ({ method: "spawn" as const, args: ["git", [], options] });
    // `cwd` is a path and is held to the same control-character refusal as every other path.
    expect(ok(webNodeChildProcessCallSchema, opts({ cwd: `/tmp/a${NUL}` }))).toBe(false);
    expect(ok(webNodeChildProcessCallSchema, opts({ cwd: "" }))).toBe(false);
    expect(ok(webNodeChildProcessCallSchema, opts({ cwd: 42 }))).toBe(false);
    expect(ok(webNodeChildProcessCallSchema, opts({ shell: 42 }))).toBe(false);
    expect(ok(webNodeChildProcessCallSchema, opts({ env: { PATH: 42 } }))).toBe(false);
    expect(ok(webNodeChildProcessCallSchema, opts({ env: { PATH: "x".repeat(131_073) } }))).toBe(false);
    expect(ok(webNodeChildProcessCallSchema, opts({ env: "PATH=/bin" }))).toBe(false);
    expect(ok(webNodeChildProcessCallSchema, opts(null))).toBe(false);
    // The legitimate forms still pass, so the refusals above are about shape, not about rejecting options wholesale.
    expect(ok(webNodeChildProcessCallSchema, opts({ shell: true }))).toBe(true);
    expect(ok(webNodeChildProcessCallSchema, opts({ shell: "/bin/zsh", env: { PATH: "/bin" } }))).toBe(true);
  });
});

describe("webNodeCallSchema (the envelope Main routes on)", () => {
  test("accepts a well-formed fs and child_process envelope (the positive control)", () => {
    expect(ok(webNodeCallSchema, { id: 1, module: "fs", method: "readFile", args: ["/tmp/a"] })).toBe(true);
    expect(
      ok(webNodeCallSchema, { id: 9007199254740991, module: "child_process", method: "exec", args: ["ls", {}] }),
    ).toBe(true);
  });

  test("refuses an id that is not a positive safe integer", () => {
    const withId = (id: unknown) => ({ id, module: "fs", method: "readFile", args: ["/tmp/a"] });
    expect(ok(webNodeCallSchema, withId(0))).toBe(false);
    expect(ok(webNodeCallSchema, withId(-1))).toBe(false);
    expect(ok(webNodeCallSchema, withId(1.5))).toBe(false);
    expect(ok(webNodeCallSchema, withId(Number.NaN))).toBe(false);
    expect(ok(webNodeCallSchema, withId(Number.POSITIVE_INFINITY))).toBe(false);
    expect(ok(webNodeCallSchema, withId("1"))).toBe(false);
    expect(ok(webNodeCallSchema, withId(undefined))).toBe(false);
  });

  test("refuses an unknown module, and a method belonging to the other module", () => {
    expect(ok(webNodeCallSchema, { id: 1, module: "net", method: "connect", args: [] })).toBe(false);
    expect(ok(webNodeCallSchema, { id: 1, module: "fs", method: "exec", args: ["ls", {}] })).toBe(false);
    // The cross-module case that matters most: a command must not ride in on the `fs` module's envelope.
    expect(ok(webNodeCallSchema, { id: 1, module: "child_process", method: "readFile", args: ["/tmp/a"] })).toBe(false);
    expect(ok(webNodeCallSchema, { id: 1, method: "readFile", args: ["/tmp/a"] })).toBe(false);
  });

  test("refuses an envelope whose payload is malformed, even with a valid id and module", () => {
    expect(ok(webNodeCallSchema, { id: 1, module: "fs", method: "readFile", args: [`/tmp/a${NUL}`] })).toBe(false);
    expect(ok(webNodeCallSchema, { id: 1, module: "fs" })).toBe(false);
    expect(ok(webNodeCallSchema, {})).toBe(false);
    expect(ok(webNodeCallSchema, null)).toBe(false);
  });
});

describe("webNodeAbortSchema", () => {
  test("accepts a positive integer id and refuses anything else", () => {
    expect(ok(webNodeAbortSchema, { id: 1 })).toBe(true);
    expect(ok(webNodeAbortSchema, { id: 0 })).toBe(false);
    expect(ok(webNodeAbortSchema, { id: -3 })).toBe(false);
    expect(ok(webNodeAbortSchema, { id: 2.5 })).toBe(false);
    expect(ok(webNodeAbortSchema, { id: "1" })).toBe(false);
    expect(ok(webNodeAbortSchema, {})).toBe(false);
    expect(ok(webNodeAbortSchema, null)).toBe(false);
  });
});
