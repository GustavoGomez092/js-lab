import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundleAppForWeb, bundleVendorForWeb, joinVendorAndApp } from "../../src/main/bundling/bundler";
import { nodePolyfills } from "../../src/main/bundling/polyfill-plugin";

/**
 * Task 10 (spec §5.13): the `browser-node` module table `apps/desktop/src/main/bundling/polyfill-plugin.ts`
 * builds. Runs the *real* `Bun.build` pipeline end to end -- the same `bundleAppForWeb`/`bundleVendorForWeb`/
 * `joinVendorAndApp` sequence `WebAdapter` uses -- and executes the joined output as a real ES module, the same
 * way the page does (`bundler.test.ts`'s own `runJoinedModule` note explains why a genuine module, not
 * `new Function`, is required once the vendor half's top-level `await` is in play).
 */

let root = "";
let workingDirectory = "";
let packagesNodeModules = "";
/** The app's data directory: what a tab with no working directory resolves against (Task 9f item 5). */
let dataDir = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "jslab-polyfill-plugin-"));
  workingDirectory = join(root, "wd");
  packagesNodeModules = join(root, "pkgs", "node_modules");
  dataDir = join(root, "data");
  await mkdir(workingDirectory, { recursive: true });
  await mkdir(packagesNodeModules, { recursive: true });
  await mkdir(dataDir, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

let joinedRunCounter = 0;

/**
 * Joined modules go in a subdirectory of their own, and that is load-bearing under Bun 1.4.0.
 *
 * **Bun 1.4.0 caches the directory listing of any directory `Bun.build` walked while resolving.** A file created
 * in that directory *afterwards* is then invisible to the module resolver: `import()` reports
 * `Cannot find module '<path>' from ''` for a file that `existsSync` confirms is there. Measured: importing from
 * the directory *before* a build works; after a build that walked it, the same write fails; a fresh directory the
 * build never touched works; and a **sibling subdirectory of the walked directory works** -- the cache is
 * per-directory, not per-tree. The module's contents are irrelevant (a five-word module fails just as a 3.6 KB
 * bundle does).
 *
 * Why only some tests hit it: resolving a package out of `packagesNodeModules` walks **up** through `root` looking
 * for `node_modules`, which lists `root` and poisons it. Builtin-only bundles are served by the polyfill plugin and
 * never list `root`, so their joined modules import fine -- which is why ~27 tests here passed while the two that
 * bundle a real package failed.
 *
 * Bun 1.3.13 does not do this. That divergence is exactly why this passed locally and failed on CI, which runs 1.4.0.
 */
async function runJoinedModule(joined: string): Promise<unknown> {
  const dir = join(root, "joined");
  await mkdir(dir, { recursive: true });
  const file = join(dir, `joined-${joinedRunCounter++}.mjs`);
  await writeFile(file, joined);
  const g = globalThis as unknown as Record<string, unknown>;
  g.__jlProbe = undefined;
  await import(file);
  return g.__jlProbe;
}

/**
 * F1. The `browser` runtime's builtin-blocking hook re-reads `args.importer` to position its error. That read was a
 * bare `readFileSync`, excused in the unbounded-reads allowlist as "best-effort inside try/catch" -- a
 * recoverability argument that answers neither hazard, because `readFileSync` on a FIFO *blocks* and no try/catch
 * can rescue a blocking syscall. Measured before the fix by driving this exact hook with a FIFO importer under a
 * hard alarm: it never returned and had to be killed.
 */
describe("nodePolyfills: the importer re-read that positions a blocked-builtin error", () => {
  /** Captures the onResolve callback the plugin registers, so the hook is driven without a full `Bun.build`. */
  function driveResolve(onError: (error: { line?: number }) => void) {
    let callback: ((args: Record<string, unknown>) => unknown) | null = null;
    const builder = {
      onResolve(_constraints: { filter: RegExp }, cb: typeof callback) {
        callback = cb;
      },
      onLoad() {},
    };
    nodePolyfills("browser", onError as never).setup(builder as never);
    return (importer: string) => {
      if (!callback) throw new Error("onResolve was never registered");
      return callback({ path: "fs", importer, namespace: "file", kind: "import-statement" });
    };
  }

  test("positions the error from a regular importer, and refuses a FIFO one instead of hanging", async () => {
    // Control first: without it, the FIFO assertion below would pass for a hook that never read the importer.
    const real = join(root, "entry.js");
    await writeFile(real, 'import fs from "fs";\n');
    const positioned: Array<{ line?: number }> = [];
    expect(() => driveResolve((error) => positioned.push(error))(real)).toThrow('blocked Node builtin "fs"');
    expect(positioned[0]?.line).toBe(1);

    // The same hook, with a FIFO importer. This read is synchronous: a regression does not time out, it parks the
    // thread and hangs the whole run, which is exactly why the refusal belongs in the reader and not in a timeout.
    const fifo = join(root, "fifo-entry.js");
    expect(await Bun.spawn(["mkfifo", fifo]).exited).toBe(0);
    const piped: Array<{ line?: number }> = [];
    expect(() => driveResolve((error) => piped.push(error))(fifo)).toThrow('blocked Node builtin "fs"');
    // The error still reports, just without a position -- the same fallback an unreadable importer already took.
    expect(piped[0]?.line).toBeUndefined();
  });
});

/**
 * Builds and runs one `browser-node` entry, returning whatever it left on `globalThis.__jlProbe`.
 *
 * `overrides.workingDirectory` may be `null` -- the tab-with-no-working-directory case (Task 9f item 5), which
 * nothing exercised before and which is exactly where the three answers to "what is the cwd?" diverged.
 */
async function runBrowserNodeEntry(
  source: string,
  overrides: { workingDirectory?: string | null } = {},
): Promise<unknown> {
  const wd = overrides.workingDirectory === undefined ? workingDirectory : overrides.workingDirectory;
  const entry = join(workingDirectory, "entry.js");
  await writeFile(entry, source);
  const app = await bundleAppForWeb({
    entry,
    runtime: "browser-node",
    workingDirectory: wd,
    packagesNodeModules,
    dataDir,
  });
  if ("error" in app) throw new Error(`app build failed: ${app.error.message}\n${app.error.codeFrame ?? ""}`);
  let joined = joinVendorAndApp(null, app.code);
  if (app.imports.length > 0) {
    const vendor = await bundleVendorForWeb({
      imports: app.imports,
      runtime: "browser-node",
      workingDirectory: wd,
      packagesNodeModules,
      dataDir,
    });
    if ("error" in vendor) throw new Error(`vendor build failed: ${vendor.error.message}`);
    joined = joinVendorAndApp(vendor.code, app.code);
  }
  return runJoinedModule(joined);
}

/**
 * Task 9b. `nodePolyfills`' second `onResolve` hook (the one serving `crypto.ts`'s own vendor entries) used to be
 * registered as `filter: /.*​/`. Merely *registering* a hook that matches every specifier corrupted Bun's output,
 * even though the callback returned `undefined` for everything but `crypto`: a package that internally does
 * `import * as ns from "./ns.js"` had its namespace object dropped while every `ns.foo(...)` call site survived, so
 * the chunk died at evaluation with `ReferenceError: ns is not defined` -- and ~425 KB of the graph went with it.
 *
 * This is the shape every real npm package hits (it was found with zod), so it is tested with a real bundle and a
 * real evaluation, not by inspecting the plugin. It is a `browser-node`-only regression: the `browser` build never
 * registered that hook, which is why only one of the two runtimes was broken.
 */
describe("browser-node bundles packages that use an internal namespace import (Task 9b)", () => {
  async function writeNamespacePackage(name: string): Promise<void> {
    const pkgDir = join(packagesNodeModules, name);
    await mkdir(pkgDir, { recursive: true });
    await writeFile(join(pkgDir, "package.json"), JSON.stringify({ name, main: "index.js", type: "module" }));
    await writeFile(
      join(pkgDir, "index.js"),
      'import * as util from "./util.js";\nexport function greet() {\n  return util.hello() + util.NAME;\n}\n',
    );
    await writeFile(
      join(pkgDir, "util.js"),
      'export function hello() {\n  return "hi ";\n}\nexport const NAME = "there";\n',
    );
  }

  test("the package's namespace object survives, so its call sites still resolve", async () => {
    await writeNamespacePackage("ns-pkg");
    const result = await runBrowserNodeEntry('import { greet } from "ns-pkg";\nglobalThis.__jlProbe = greet();\n');
    expect(result).toBe("hi there");
  });

  test("the same package works under the browser runtime too, so the two runtimes agree", async () => {
    await writeNamespacePackage("ns-pkg2");
    const entry = join(workingDirectory, "entry-browser.js");
    await writeFile(entry, 'import { greet } from "ns-pkg2";\nglobalThis.__jlProbe = greet();\n');
    const app = await bundleAppForWeb({ entry, runtime: "browser", workingDirectory, packagesNodeModules, dataDir });
    if ("error" in app) throw new Error(`app build failed: ${app.error.message}`);
    const vendor = await bundleVendorForWeb({
      imports: app.imports,
      runtime: "browser",
      workingDirectory,
      packagesNodeModules,
      dataDir,
    });
    if ("error" in vendor) throw new Error(`vendor build failed: ${vendor.error.message}`);
    expect(await runJoinedModule(joinVendorAndApp(vendor.code, app.code))).toBe("hi there");
  });
});

describe("browser-node module table -- the ten sync builtins (spec §5.13)", () => {
  test("buffer: Buffer.from/toString round-trips", async () => {
    const result = await runBrowserNodeEntry(
      "import { Buffer } from 'buffer';\nglobalThis.__jlProbe = Buffer.from('hi').toString('utf8');\n",
    );
    expect(result).toBe("hi");
  });

  test("path: join behaves like Node's path.join", async () => {
    const result = await runBrowserNodeEntry(
      "import path from 'path';\nglobalThis.__jlProbe = path.join('a', 'b', 'c');\n",
    );
    expect(result).toBe("a/b/c");
  });

  /**
   * Fix round 2 (B0): `path` was the sole failure of the ten sync builtins in the *named* import form, in both
   * the bare and `node:`-prefixed spellings -- `path-browserify/index.js` ends with `module.exports = posix`, a
   * single object assignment Bun's CJS->ESM named-export synthesis can't destructure (the same class of gap I1
   * fixed for `process`/`os`/`crypto`), and unlike the other nine vendored builtins it had no synthetic
   * re-export entry to route around it. Untested until now: every existing `path` test used the default form.
   */
  test("path: named join works too (fix round 2, B0)", async () => {
    const result = await runBrowserNodeEntry(
      "import { join } from 'path';\nglobalThis.__jlProbe = join('a', 'b', 'c');\n",
    );
    expect(result).toBe("a/b/c");
  });

  test("path: named join works with the node: prefix too", async () => {
    const result = await runBrowserNodeEntry(
      "import { join } from 'node:path';\nglobalThis.__jlProbe = join('a', 'b', 'c');\n",
    );
    expect(result).toBe("a/b/c");
  });

  test("events: EventEmitter dispatches synchronously", async () => {
    const result = await runBrowserNodeEntry(
      [
        "import { EventEmitter } from 'events';",
        "const ee = new EventEmitter();",
        "let got = false;",
        "ee.on('x', () => { got = true; });",
        "ee.emit('x');",
        "globalThis.__jlProbe = got;",
        "",
      ].join("\n"),
    );
    expect(result).toBe(true);
  });

  test("util: inspect and promisify both work", async () => {
    const result = await runBrowserNodeEntry(
      [
        "import { inspect, promisify } from 'util';",
        "async function main() {",
        "  const cb = (a, done) => done(null, a + 1);",
        "  const value = await promisify(cb)(41);",
        "  globalThis.__jlProbe = inspect({ a: 1 }) + '|' + value;",
        "}",
        "await main();",
        "",
      ].join("\n"),
    );
    expect(result).toBe("{ a: 1 }|42");
  });

  test("url: legacy parse plus the real WHATWG URL/URLSearchParams globals", async () => {
    const result = await runBrowserNodeEntry(
      [
        "import { parse, URL, URLSearchParams } from 'url';",
        "const host = parse('https://example.com/a?b=1', true).hostname;",
        "const path = new URL('https://x.com/y').pathname;",
        "const hasParams = typeof URLSearchParams === 'function';",
        "globalThis.__jlProbe = [host, path, hasParams].join('|');",
        "",
      ].join("\n"),
    );
    expect(result).toBe("example.com|/y|true");
  });

  test("querystring: stringify/parse round-trip", async () => {
    const result = await runBrowserNodeEntry(
      [
        "import qs from 'querystring';",
        "const s = qs.stringify({ a: 1, b: 2 });",
        "const parsed = qs.parse('c=3');",
        "globalThis.__jlProbe = s + '|' + JSON.stringify(parsed);",
        "",
      ].join("\n"),
    );
    expect(result).toBe('a=1&b=2|{"c":"3"}');
  });

  test("string_decoder: decodes a Buffer chunk", async () => {
    const result = await runBrowserNodeEntry(
      [
        "import { Buffer } from 'buffer';",
        "import { StringDecoder } from 'string_decoder';",
        "const sd = new StringDecoder('utf8');",
        "globalThis.__jlProbe = sd.write(Buffer.from('hi'));",
        "",
      ].join("\n"),
    );
    expect(result).toBe("hi");
  });

  test("assert: passes on a true assertion, named strictEqual works", async () => {
    const result = await runBrowserNodeEntry(
      [
        "import assert, { strictEqual } from 'assert';",
        "assert(true);",
        "strictEqual(1, 1);",
        "globalThis.__jlProbe = 'ok';",
        "",
      ].join("\n"),
    );
    expect(result).toBe("ok");
  });

  test("assert: throws AssertionError on a false assertion", async () => {
    const result = await runBrowserNodeEntry(
      [
        "import assert from 'assert';",
        "try {",
        "  assert.strictEqual(1, 2);",
        "  globalThis.__jlProbe = 'did-not-throw';",
        "} catch (e) {",
        "  globalThis.__jlProbe = e.name;",
        "}",
        "",
      ].join("\n"),
    );
    expect(result).toBe("AssertionError");
  });

  test("stream: Readable/Writable/Transform are constructible and pipe() works", async () => {
    const result = await runBrowserNodeEntry(
      [
        "import { Readable, Writable } from 'stream';",
        "const chunks = [];",
        "const readable = new Readable({ read() {} });",
        "const writable = new Writable({",
        "  write(chunk, _enc, cb) { chunks.push(chunk.toString()); cb(); },",
        "});",
        "readable.pipe(writable);",
        "readable.push('hello');",
        "readable.push(null);",
        "await new Promise((resolve) => writable.on('finish', resolve));",
        "globalThis.__jlProbe = chunks.join('');",
        "",
      ].join("\n"),
    );
    expect(result).toBe("hello");
  });

  test("punycode: toASCII/toUnicode round-trip an internationalized hostname", async () => {
    const result = await runBrowserNodeEntry(
      [
        "import punycode from 'punycode';",
        "const ascii = punycode.toASCII('m\\u00fc.de');",
        "const unicode = punycode.toUnicode(ascii);",
        "globalThis.__jlProbe = ascii + '|' + unicode;",
        "",
      ].join("\n"),
    );
    expect(result).toBe("xn--m-eha.de|mü.de");
  });
});

describe("browser-node module table -- process (spec §5.13)", () => {
  test("env/cwd/platform/argv/versions come from the snapshot", async () => {
    const result = await runBrowserNodeEntry(
      [
        "import process from 'process';",
        "globalThis.__jlProbe = {",
        "  hasEnv: typeof process.env === 'object',",
        "  platform: process.platform,",
        "  cwd: process.cwd(),",
        "  argvIsArray: Array.isArray(process.argv),",
        "  hasVersions: typeof process.versions === 'object',",
        "};",
        "",
      ].join("\n"),
    );
    expect(result).toEqual({
      hasEnv: true,
      platform: process.platform,
      cwd: workingDirectory,
      argvIsArray: true,
      hasVersions: true,
    });
  });

  test("nextTick schedules on the microtask queue, before a macrotask", async () => {
    // Top-level `await`s the macrotask itself, so `import()` (and therefore `runBrowserNodeEntry`) only resolves
    // once every callback below has already run and `order` is final -- no polling or fixed sleep required.
    const result = await runBrowserNodeEntry(
      [
        "import process from 'process';",
        "const order = [];",
        "process.nextTick(() => order.push('nextTick'));",
        "order.push('sync');",
        "await new Promise((resolve) => setTimeout(() => { order.push('macrotask'); resolve(); }, 0));",
        "globalThis.__jlProbe = order;",
        "",
      ].join("\n"),
    );
    expect(result).toEqual(["sync", "nextTick", "macrotask"]);
  });

  /**
   * The constraint the Task 10 brief calls out by name: the snapshot must go through `runnerEnvironment`'s exact
   * layering and reserved-key stripping (`apps/desktop/src/main/app-paths.ts`), not a second, parallel builder.
   * `process.env` here is Main's own env -- the same one `runnerEnvironment`'s `base` layer reads -- so setting
   * `JSLAB_*`/`BUN_OPTIONS` on the *test process's* `process.env` and asserting they never reach the bundled
   * snapshot proves the real stripping function ran, not a copy of its keyword list.
   */
  test("process.env strips every JSLAB_* key and BUN_OPTIONS, keeps an ordinary key", async () => {
    const addedKeys = ["JSLAB_USER_DATA", "JSLAB_SECRET", "BUN_OPTIONS", "JSLAB_TASK10_MARKER"] as const;
    process.env.JSLAB_USER_DATA = "/should/never/leak";
    process.env.JSLAB_SECRET = "also-should-never-leak";
    process.env.BUN_OPTIONS = "--preload=/evil.js";
    process.env.JSLAB_TASK10_MARKER = "1";
    try {
      const result = await runBrowserNodeEntry(
        [
          "import process from 'process';",
          "globalThis.__jlProbe = {",
          "  hasJslabUserData: 'JSLAB_USER_DATA' in process.env,",
          "  hasJslabSecret: 'JSLAB_SECRET' in process.env,",
          "  hasBunOptions: 'BUN_OPTIONS' in process.env,",
          "  hasJslabMarker: process.env.JSLAB === '1',",
          "};",
          "",
        ].join("\n"),
      );
      expect(result).toEqual({
        hasJslabUserData: false,
        hasJslabSecret: false,
        hasBunOptions: false,
        // Not the test's own injected JSLAB_TASK10_MARKER (also stripped, same prefix) -- `runnerEnvironment`
        // always sets its own `JSLAB=1` as the very last layer, which is what this checks for.
        hasJslabMarker: true,
      });
    } finally {
      for (const key of addedKeys) delete process.env[key];
    }
  });
});

describe("browser-node module table -- os (spec §5.13, snapshot values)", () => {
  test("every accessor returns a real value from Main's own node:os", async () => {
    const os = await import("node:os");
    const result = await runBrowserNodeEntry(
      [
        "import osMod from 'os';",
        "globalThis.__jlProbe = {",
        "  platform: osMod.platform(),",
        "  arch: osMod.arch(),",
        "  homedir: osMod.homedir(),",
        "  eol: osMod.EOL,",
        "  cpuCount: osMod.cpus().length,",
        "};",
        "",
      ].join("\n"),
    );
    expect(result).toEqual({
      platform: os.platform(),
      arch: os.arch(),
      homedir: os.homedir(),
      eol: os.EOL,
      cpuCount: os.cpus().length,
    });
  });
});

describe("browser-node module table -- crypto (spec §5.13)", () => {
  test("randomUUID/getRandomValues/webcrypto are the real native ones", async () => {
    const result = await runBrowserNodeEntry(
      [
        "import crypto from 'crypto';",
        "const uuid = crypto.randomUUID();",
        "const bytes = crypto.getRandomValues(new Uint8Array(8));",
        "globalThis.__jlProbe = {",
        "  uuidLooksRight: /^[0-9a-f-]{36}$/i.test(uuid),",
        "  bytesFilled: bytes.some((b) => b !== 0),",
        "  hasWebcrypto: typeof crypto.webcrypto.subtle === 'object',",
        "};",
        "",
      ].join("\n"),
    );
    expect(result).toEqual({ uuidLooksRight: true, bytesFilled: true, hasWebcrypto: true });
  });

  test("createHash/createHmac produce real, correct digests", async () => {
    const result = await runBrowserNodeEntry(
      [
        "import crypto from 'crypto';",
        "const sha256 = crypto.createHash('sha256').update('abc').digest('hex');",
        "const hmac = crypto.createHmac('sha256', 'key').update('abc').digest('hex');",
        "globalThis.__jlProbe = sha256 + '|' + hmac;",
        "",
      ].join("\n"),
    );
    expect(result).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad|9c196e32dc0175f86f4b1cb89289d6619de6bee699e4c378e68309ed97a1a6ab",
    );
  });
});

/**
 * Fix round 1 (I1): `process`, `os` and `crypto` exposed only a default export -- so `import { createHash } from
 * 'crypto'` (an ordinary spelling, not an exotic one) failed the build outright with "no matching export", and
 * every existing test used the default form only, so the gap was invisible. These tests use the *named* form
 * specifically, so the gap cannot reopen silently the way it did the first time.
 */
describe("browser-node module table -- named imports (fix round 1, I1)", () => {
  test("process: named env/platform/cwd/nextTick all work", async () => {
    const result = await runBrowserNodeEntry(
      [
        "import { env, platform, cwd, nextTick } from 'process';",
        "const order = [];",
        "nextTick(() => order.push('nextTick'));",
        "order.push('sync');",
        "globalThis.__jlProbe = {",
        "  hasEnv: typeof env === 'object',",
        "  platform,",
        "  cwd: cwd(),",
        "  order,",
        "};",
        "",
      ].join("\n"),
    );
    // By the time `import()` itself resolves, `nextTick`'s microtask has already had a chance to run (module
    // evaluation completing is itself several microtask hops) -- this only asserts named `env`/`platform`/`cwd`
    // actually work, not nextTick's exact timing (the dedicated `nextTick` describe block below covers that).
    expect(result).toEqual({
      hasEnv: true,
      platform: process.platform,
      cwd: workingDirectory,
      order: ["sync", "nextTick"],
    });
  });

  test("os: named platform/arch/cpus all work", async () => {
    const os = await import("node:os");
    const result = await runBrowserNodeEntry(
      [
        "import { platform, arch, cpus } from 'os';",
        "globalThis.__jlProbe = [platform(), arch(), cpus().length];",
        "",
      ].join("\n"),
    );
    expect(result).toEqual([os.platform(), os.arch(), os.cpus().length]);
  });

  test("crypto: named createHash/createHmac/randomUUID all work", async () => {
    const result = await runBrowserNodeEntry(
      [
        "import { createHash, createHmac, randomUUID } from 'crypto';",
        "const sha256 = createHash('sha256').update('abc').digest('hex');",
        "const hmac = createHmac('sha256', 'key').update('abc').digest('hex');",
        "globalThis.__jlProbe = { sha256, hmac, uuidLooksRight: /^[0-9a-f-]{36}$/i.test(randomUUID()) };",
        "",
      ].join("\n"),
    );
    expect(result).toEqual({
      sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      hmac: "9c196e32dc0175f86f4b1cb89289d6619de6bee699e4c378e68309ed97a1a6ab",
      uuidLooksRight: true,
    });
  });
});

/**
 * Fix round 1 (I2): a `node:`-prefixed specifier used to bypass the module table entirely -- `node:path`/
 * `node:buffer` silently fell through to Bun's own internal browser shims (not the vendored polyfills this task
 * ships), and `node:process` hard-errored. One vendored builtin, one snapshot-backed module, both spellings.
 */
describe("browser-node module table -- node: prefix (fix round 1, I2)", () => {
  /**
   * Fix round 2: the previous version of this test only checked `Buffer.from('hi').toString('utf8') === 'hi'`
   * -- an assertion Bun's own internal `node:buffer` shim satisfies too, which is exactly what `node:buffer`
   * silently fell through to *before* I2 was fixed (round 1's own measurement: "node:buffer -> works"). A test
   * whose assertion the pre-fix behavior already passes cannot detect a regression back to it. This version
   * asserts *module identity* against the unprefixed spelling instead -- the same probe shape the fix round 1
   * re-review used to verify I2 independently -- which only holds if both specifiers resolve to the exact same
   * vendored module instance, not two separately-shimmed ones that merely behave alike.
   */
  test("node:buffer is the same Buffer class as buffer, not a separately-shimmed one", async () => {
    const result = await runBrowserNodeEntry(
      [
        "import { Buffer as A } from 'buffer';",
        "import { Buffer as B } from 'node:buffer';",
        "globalThis.__jlProbe = A === B;",
        "",
      ].join("\n"),
    );
    expect(result).toBe(true);
  });

  test("node:path is the same module as path, not a separately-shimmed one", async () => {
    const result = await runBrowserNodeEntry(
      ["import a from 'path';", "import b from 'node:path';", "globalThis.__jlProbe = a === b;", ""].join("\n"),
    );
    expect(result).toBe(true);
  });

  test("node:process builds and runs (previously a hard build error)", async () => {
    const result = await runBrowserNodeEntry(
      "import process from 'node:process';\nglobalThis.__jlProbe = process.platform;\n",
    );
    expect(result).toBe(process.platform);
  });

  test("node:os builds and runs, matching the unprefixed spelling", async () => {
    const os = await import("node:os");
    const result = await runBrowserNodeEntry("import osMod from 'node:os';\nglobalThis.__jlProbe = osMod.arch();\n");
    expect(result).toBe(os.arch());
  });

  test("node:crypto builds and runs, matching the unprefixed spelling", async () => {
    const result = await runBrowserNodeEntry(
      "import crypto from 'node:crypto';\nglobalThis.__jlProbe = crypto.createHash('md5').update('abc').digest('hex');\n",
    );
    expect(result).toBe("900150983cd24fb0d6963f7d28e17f72");
  });
});

/**
 * Task 11 (spec §5.13): the async bridge's own table entries, through the same real `Bun.build` pipeline.
 *
 * These are the end-to-end tests for the gap this task closed. Before it, `fs`, `child_process` and the six
 * throw-only builtins fell through the plugin unhandled and `Bun.build({target:'browser'})` silently stubbed them,
 * so a `browser-node` tab offered neither the Node APIs the spec promises nor the refusal it mandates -- and a
 * plugin-level assertion could not have caught that, because the plugin was not the thing that was wrong.
 */
describe("browser-node module table -- the async Node bridge (Task 11, spec §5.13)", () => {
  test("fs.readFileSync throws the spec's exact message from inside a real bundle", async () => {
    const result = await runBrowserNodeEntry(
      [
        "import fs from 'fs';",
        "try {",
        "  fs.readFileSync('/etc/passwd');",
        "  globalThis.__jlProbe = 'did-not-throw';",
        "} catch (e) {",
        "  globalThis.__jlProbe = e.name + ': ' + e.message;",
        "}",
        "",
      ].join("\n"),
    );
    expect(result).toBe(
      'JSLabUnsupportedError: fs.readFileSync isn\'t available in "Browser & Node APIs". Use fs/promises or switch this tab to the Bun runtime.',
    );
  });

  test("a named sync import refuses too, with its own method name", async () => {
    const result = await runBrowserNodeEntry(
      [
        "import { writeFileSync } from 'fs';",
        "try {",
        "  writeFileSync('x', 'y');",
        "  globalThis.__jlProbe = 'did-not-throw';",
        "} catch (e) {",
        "  globalThis.__jlProbe = e.message;",
        "}",
        "",
      ].join("\n"),
    );
    expect(result).toBe(
      'fs.writeFileSync isn\'t available in "Browser & Node APIs". Use fs/promises or switch this tab to the Bun runtime.',
    );
  });

  test("child_process.execSync refuses as well", async () => {
    const result = await runBrowserNodeEntry(
      [
        "import { execSync } from 'child_process';",
        "try {",
        "  execSync('ls');",
        "  globalThis.__jlProbe = 'did-not-throw';",
        "} catch (e) {",
        "  globalThis.__jlProbe = e.name + '|' + e.message;",
        "}",
        "",
      ].join("\n"),
    );
    expect(result).toBe(
      'JSLabUnsupportedError|child_process.execSync isn\'t available in "Browser & Node APIs". Use child_process.exec or switch this tab to the Bun runtime.',
    );
  });

  // The CommonJS shape is what makes this work: a named import off an ES module would have failed the *build*
  // with "no matching export", which names neither the runtime nor the way out.
  test("each throw-only module refuses on use, in both the default and named import forms", async () => {
    const result = await runBrowserNodeEntry(
      [
        "import http from 'http';",
        "import { createServer } from 'http';",
        "const out = [];",
        "try { http.createServer(); } catch (e) { out.push(e.name + ': ' + e.message); }",
        "try { createServer(); } catch (e) { out.push(e.name); }",
        "globalThis.__jlProbe = out;",
        "",
      ].join("\n"),
    );
    expect(result).toEqual([
      'JSLabUnsupportedError: http isn\'t available in "Browser & Node APIs". Switch this tab to the Bun runtime.',
      "JSLabUnsupportedError",
    ]);
  });

  test("net, tls, dgram, worker_threads and vm all refuse the same way", async () => {
    const result = await runBrowserNodeEntry(
      [
        "import net from 'net';",
        "import tls from 'tls';",
        "import dgram from 'dgram';",
        "import worker_threads from 'worker_threads';",
        "import vm from 'vm';",
        "const names = [];",
        "for (const [label, mod] of [['net', net], ['tls', tls], ['dgram', dgram], ['worker_threads', worker_threads], ['vm', vm]]) {",
        "  try { mod.anything; names.push('did-not-throw'); } catch (e) { names.push(label + ':' + e.name); }",
        "}",
        "globalThis.__jlProbe = names;",
        "",
      ].join("\n"),
    );
    expect(result).toEqual([
      "net:JSLabUnsupportedError",
      "tls:JSLabUnsupportedError",
      "dgram:JSLabUnsupportedError",
      "worker_threads:JSLabUnsupportedError",
      "vm:JSLabUnsupportedError",
    ]);
  });

  /**
   * CodeRabbit finding 1. `unsupportedModuleSource` emitted EVERY name in `UNSUPPORTED_MODULE_EXPORTS` as
   * `function () { return __jslabRefuse(); }`. That is right for a callable (`createServer`, `Worker`) and wrong
   * for a **data-valued** one: `http.STATUS_CODES` is an object and `http.METHODS` an array in Node, so binding
   * them to a function made `STATUS_CODES[200]` read back as `undefined` and `METHODS.length` as `0` -- the
   * §5.13 refusal contract silently defeated, with no `JSLabUnsupportedError` anywhere.
   *
   * The audit of the whole table (not just the two names CodeRabbit happened to cite) finds six data-valued
   * exports: `http.STATUS_CODES`, `http.METHODS`, and `worker_threads`' `isMainThread`, `parentPort`,
   * `workerData` and `threadId`. Every one is covered here.
   */
  test("a data-valued export refuses on property access, not only when called (CodeRabbit 1)", async () => {
    const result = await runBrowserNodeEntry(
      [
        "import { STATUS_CODES, METHODS } from 'http';",
        "import { isMainThread, parentPort, workerData, threadId } from 'worker_threads';",
        "const out = [];",
        "const probe = (label, fn) => {",
        "  try { fn(); out.push(label + ':did-not-throw'); } catch (e) { out.push(label + ':' + e.name); }",
        "};",
        "probe('STATUS_CODES[200]', () => STATUS_CODES[200]);",
        "probe('METHODS.length', () => METHODS.length);",
        "probe('parentPort.postMessage', () => parentPort.postMessage(1));",
        "probe('workerData.job', () => workerData.job);",
        "probe('threadId.toFixed', () => threadId.toFixed(0));",
        "probe('isMainThread.valueOf', () => isMainThread.valueOf());",
        "globalThis.__jlProbe = out;",
        "",
      ].join("\n"),
    );
    expect(result).toEqual([
      "STATUS_CODES[200]:JSLabUnsupportedError",
      "METHODS.length:JSLabUnsupportedError",
      "parentPort.postMessage:JSLabUnsupportedError",
      "workerData.job:JSLabUnsupportedError",
      "threadId.toFixed:JSLabUnsupportedError",
      "isMainThread.valueOf:JSLabUnsupportedError",
    ]);
  });

  /**
   * The truthiness half of CodeRabbit finding 1, and the honest limit of what JavaScript allows.
   *
   * `if (parentPort)` CANNOT be made to throw: `ToBoolean` has no trap -- not on a Proxy, not through
   * `Symbol.toPrimitive` -- and every object is truthy, so a guard on a data-valued binding necessarily takes the
   * "present" branch. What the fix guarantees instead is that the guard cannot silently hand back a *usable*
   * value: the very next thing such code does is read a property off it, and that refuses. This test pins that
   * whole guard-then-use path, which is the shape real `worker_threads` code actually takes.
   */
  test("a truthy data-valued guard still refuses the moment the value is used (CodeRabbit 1)", async () => {
    const result = await runBrowserNodeEntry(
      [
        "import { parentPort } from 'worker_threads';",
        "let reached = 'guard-was-falsy';",
        "if (parentPort) {",
        "  try { parentPort.postMessage('hi'); reached = 'did-not-throw'; }",
        "  catch (e) { reached = e.name + ': ' + e.message; }",
        "}",
        "globalThis.__jlProbe = reached;",
        "",
      ].join("\n"),
    );
    expect(result).toBe(
      'JSLabUnsupportedError: worker_threads isn\'t available in "Browser & Node APIs". Switch this tab to the Bun runtime.',
    );
  });

  /**
   * The round trip a real tab makes: the bundled `fs/promises` module reads the client the bootstrap installed on
   * the page global. Here the bootstrap's role is played by a fake installed on `globalThis` before the joined
   * module runs, which is the same realm the bundle evaluates in.
   */
  test("fs/promises forwards to the bridge the bootstrap installed on the page global", async () => {
    const g = globalThis as unknown as Record<string, unknown>;
    const asked: unknown[] = [];
    g.__jslabNodeBridge = {
      fsPromises: {
        readFile: (...args: unknown[]) => {
          asked.push(args);
          return Promise.resolve("from the bridge");
        },
      },
    };
    try {
      const result = await runBrowserNodeEntry(
        [
          "import { readFile } from 'fs/promises';",
          "globalThis.__jlProbe = await readFile('notes.txt', 'utf8');",
          "",
        ].join("\n"),
      );
      expect(result).toBe("from the bridge");
      expect(asked).toEqual([["notes.txt", "utf8"]]);
    } finally {
      delete g.__jslabNodeBridge;
    }
  });

  test("node:fs/promises resolves to the same bridged module as the unprefixed spelling", async () => {
    const g = globalThis as unknown as Record<string, unknown>;
    g.__jslabNodeBridge = { fsPromises: { readFile: () => Promise.resolve("prefixed") } };
    try {
      const result = await runBrowserNodeEntry(
        ["import { readFile } from 'node:fs/promises';", "globalThis.__jlProbe = await readFile('a');", ""].join("\n"),
      );
      expect(result).toBe("prefixed");
    } finally {
      delete g.__jslabNodeBridge;
    }
  });
});

/**
 * Task 9f item 1: `querystring.unescape` must be tolerant of malformed percent input, as Node's is.
 *
 * The generated module exported `globalThis.decodeURIComponent` directly as `unescape`, so a lone `%` threw
 * `URIError` where Node returns the input unchanged. Node's own `querystring.unescape` wraps `decodeURIComponent`
 * and falls back on failure -- a runtime whose entire purpose is Node compatibility must not diverge here.
 */
describe("browser-node module table -- querystring.unescape tolerates malformed input (Task 9f item 1)", () => {
  test("a lone percent comes back unchanged instead of throwing URIError", async () => {
    const result = await runBrowserNodeEntry(
      [
        "import { unescape } from 'querystring';",
        "const out = [];",
        "for (const input of ['%', 'abc%', '%zz', '%E0%A4%A']) {",
        "  try { out.push(unescape(input)); } catch (e) { out.push(e.name); }",
        "}",
        "globalThis.__jlProbe = out;",
        "",
      ].join("\n"),
    );
    expect(result).toEqual(["%", "abc%", "%zz", "%E0%A4%A"]);
  });

  test("well-formed input still decodes exactly as before", async () => {
    const result = await runBrowserNodeEntry(
      [
        "import qs from 'querystring';",
        "globalThis.__jlProbe = [qs.unescape('a%20b'), qs.unescape('%C3%BC'), qs.escape('a b')].join('|');",
        "",
      ].join("\n"),
    );
    expect(result).toBe("a b|ü|a%20b");
  });
});

/*
 * Task 9f item 2 (shared built-in constructor identity across `stream`, `events` and `buffer`) is REAL but is NOT
 * fixed here, so no test for it is left behind failing. Measured at HEAD: `new Readable() instanceof EventEmitter`
 * is `false`, and a chunk a stream emits is not `instanceof` the `Buffer` that `buffer` exports, because each
 * vendor file flattens its own private copy of the built-ins it depends on.
 *
 * The prescribed fix -- `--external` in `packages/runner-web/scripts-src/generate-vendor.sh` -- provably does not
 * work: Bun ignores `--external` for Node built-in names under `--target=browser`, and the plugin equivalent drops
 * CommonJS `require()` dependencies instead of emitting imports, producing a bundle that is broken at runtime. The
 * full measurements, and what a real fix would take (one shared module graph for the built-ins, which is a redesign
 * of the vendor layer rather than a flag), are recorded in that script's own header.
 */

/**
 * Task 9f item 3: the virtual `process` must be bound inside vendored sources.
 *
 * `onLoad` returned each vendor file's text raw, with nothing prepended, while `assert.js` references
 * `process.env` and `path-browserify.js` references `process.cwd`. In a real page there is no `process` global at
 * all, so those are unbound references. Under Bun the test realm *does* have a `process` global, which is why this
 * never threw in a test -- it silently read the wrong one. Asserting against the snapshot's cwd (the tab's working
 * directory) rather than the test process's own cwd is what distinguishes the two.
 */
describe("browser-node module table -- vendored sources see the table's process (Task 9f item 3)", () => {
  test("path.resolve uses the tab's snapshot cwd, not the host process's cwd", async () => {
    const result = await runBrowserNodeEntry(
      ["import path from 'path';", "globalThis.__jlProbe = path.resolve('x');", ""].join("\n"),
    );
    expect(result).toBe(join(workingDirectory, "x"));
    expect(result).not.toBe(join(process.cwd(), "x"));
  });
});

/**
 * Task 9f item 5: `process.cwd()`, where `fs` actually resolves a relative path, and what `bun` would use must all
 * name the same directory -- including for a tab with **no working directory**, the case no test covered at all.
 *
 * Task 11 made the `fs`/`child_process` bridge resolve against `workingDirectory ?? dataDir`, matching the Bun
 * runner (`apps/desktop/src/main/runs/runner-config.ts`, which also sets `env.PWD = cwd`). The `process` snapshot
 * was left reporting **Main's own process cwd**, so a tab with no working directory saw three different answers.
 */
describe("browser-node module table -- process.cwd with no working directory (Task 9f item 5)", () => {
  test("process.cwd(), PWD and path.resolve all agree on the data directory", async () => {
    const result = await runBrowserNodeEntry(
      [
        "import process from 'process';",
        "import path from 'path';",
        "globalThis.__jlProbe = {",
        "  cwd: process.cwd(),",
        "  pwd: process.env.PWD,",
        "  resolved: path.resolve('notes.txt'),",
        "};",
        "",
      ].join("\n"),
      { workingDirectory: null },
    );
    expect(result).toEqual({
      cwd: dataDir,
      pwd: dataDir,
      resolved: join(dataDir, "notes.txt"),
    });
  });

  test("a tab that does have a working directory still reports that, not the data directory", async () => {
    const result = await runBrowserNodeEntry(
      [
        "import process from 'process';",
        "import path from 'path';",
        "globalThis.__jlProbe = { cwd: process.cwd(), pwd: process.env.PWD, resolved: path.resolve('notes.txt') };",
        "",
      ].join("\n"),
    );
    expect(result).toEqual({
      cwd: workingDirectory,
      pwd: workingDirectory,
      resolved: join(workingDirectory, "notes.txt"),
    });
  });
});
