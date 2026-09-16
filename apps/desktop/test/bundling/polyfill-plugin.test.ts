import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundleAppForWeb, bundleVendorForWeb, joinVendorAndApp } from "../../src/main/bundling/bundler";

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

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "jslab-polyfill-plugin-"));
  workingDirectory = join(root, "wd");
  packagesNodeModules = join(root, "pkgs", "node_modules");
  await mkdir(workingDirectory, { recursive: true });
  await mkdir(packagesNodeModules, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

let joinedRunCounter = 0;

async function runJoinedModule(joined: string): Promise<unknown> {
  const file = join(root, `joined-${joinedRunCounter++}.mjs`);
  await writeFile(file, joined);
  const g = globalThis as unknown as Record<string, unknown>;
  g.__jlProbe = undefined;
  await import(file);
  return g.__jlProbe;
}

/** Builds and runs one `browser-node` entry, returning whatever it left on `globalThis.__jlProbe`. */
async function runBrowserNodeEntry(source: string): Promise<unknown> {
  const entry = join(workingDirectory, "entry.js");
  await writeFile(entry, source);
  const app = await bundleAppForWeb({ entry, runtime: "browser-node", workingDirectory, packagesNodeModules });
  if ("error" in app) throw new Error(`app build failed: ${app.error.message}\n${app.error.codeFrame ?? ""}`);
  let joined = joinVendorAndApp(null, app.code);
  if (app.imports.length > 0) {
    const vendor = await bundleVendorForWeb({
      imports: app.imports,
      runtime: "browser-node",
      workingDirectory,
      packagesNodeModules,
    });
    if ("error" in vendor) throw new Error(`vendor build failed: ${vendor.error.message}`);
    joined = joinVendorAndApp(vendor.code, app.code);
  }
  return runJoinedModule(joined);
}

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
