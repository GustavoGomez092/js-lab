import { readFileSync } from "node:fs";
import * as nodeOs from "node:os";
import cryptoSrcModule from "@jslab/runner-web/polyfills/crypto.ts.txt" with { type: "text" };
// @ts-expect-error -- `os.ts` has no default export, and that's by design.
import osSrc from "@jslab/runner-web/polyfills/os.ts.txt" with { type: "text" };
/*
 * Task 10 (spec §5.13): every import below reads a `packages/runner-web/src/polyfills/**` file's raw text at
 * *this* build's compile time (an import attribute, not a normal import), so its source ships inside Main's own
 * compiled output with no dependency on a `node_modules` folder existing next to the packaged app. Each subpath
 * ends in `.txt` -- a `package.json` export-map alias to the real `.ts`/`.js` file, not the file's real name; see
 * `text-imports.d.ts` for why the alias (not the real subpath) is what makes this typecheck.
 *
 * `process.ts`/`os.ts` export no default (see each file's own comment on why), which TypeScript treats as a hard
 * error on a normal default import (TS1192) even under `{ type: "text" }` -- it has no built-in notion of that
 * attribute and resolves the real file's real shape regardless, hence the `@ts-expect-error`s. `crypto.ts` *does*
 * have a default export, so its import doesn't error, but its inferred type (`CryptoPolyfill`, not `string`) fails
 * where the text is used below -- the `as unknown as string` cast is exactly as narrow a lie as the two
 * `@ts-expect-error`s are.
 */
// @ts-expect-error -- `process.ts` has no default export, and that's by design.
import processSrc from "@jslab/runner-web/polyfills/process.ts.txt" with { type: "text" };
import type { Runtime } from "@jslab/shared";
import type { BunPlugin } from "bun";
import { runnerEnvironment } from "../app-paths";
import type { BundleError } from "./bundler";
import { buildCodeFrame, locateImport } from "./locate-import";
import { isNodeBuiltin, stripNodePrefix } from "./node-builtins";

const cryptoSrc = cryptoSrcModule as unknown as string;

import assertVendor from "@jslab/runner-web/polyfills/vendor/assert.js.txt" with { type: "text" };
// The ten §5.13 sync builtins: each a real npm polyfill, pre-flattened (every transitive `require()` already
// inlined -- see the Task 10 report for why, and each vendor file's own header for its exact provenance/version).
import bufferVendor from "@jslab/runner-web/polyfills/vendor/buffer.js.txt" with { type: "text" };
// `crypto.ts`'s own `createHash`/`createHmac` implementation (see its comment for the two-path resolution trick).
import createHashVendor from "@jslab/runner-web/polyfills/vendor/create-hash.js.txt" with { type: "text" };
import createHmacVendor from "@jslab/runner-web/polyfills/vendor/create-hmac.js.txt" with { type: "text" };
import eventsVendor from "@jslab/runner-web/polyfills/vendor/events.js.txt" with { type: "text" };
import pathVendor from "@jslab/runner-web/polyfills/vendor/path-browserify.js.txt" with { type: "text" };
import punycodeVendor from "@jslab/runner-web/polyfills/vendor/punycode.js.txt" with { type: "text" };
import querystringVendor from "@jslab/runner-web/polyfills/vendor/querystring-es3.js.txt" with { type: "text" };
import streamVendor from "@jslab/runner-web/polyfills/vendor/stream-browserify.js.txt" with { type: "text" };
import stringDecoderVendor from "@jslab/runner-web/polyfills/vendor/string_decoder.js.txt" with { type: "text" };
import urlVendor from "@jslab/runner-web/polyfills/vendor/url.js.txt" with { type: "text" };
import utilVendor from "@jslab/runner-web/polyfills/vendor/util.js.txt" with { type: "text" };

/** What Main knows about a tab's run that a `browser-node` snapshot needs (spec §5.13). Both fields already exist
 * on `BundleOptions`/`VendorBundleOptions` -- no new plumbing required beyond the two call sites in `bundler.ts`.
 */
export interface BrowserNodeContext {
  /** The tab's working directory, or null when none is set (spec §5.3). */
  workingDirectory: string | null;
  /** `apps/desktop/src/main/app-paths.ts:46`'s `packagesNodeModules` -- what `runnerEnvironment` needs for `NODE_PATH`. */
  packagesNodeModules: string;
}

const VENDOR_TABLE: Record<string, string> = {
  buffer: bufferVendor,
  path: pathVendor,
  events: eventsVendor,
  util: utilVendor,
  url: urlVendor,
  querystring: querystringVendor,
  string_decoder: stringDecoderVendor,
  assert: assertVendor,
  stream: streamVendor,
  punycode: punycodeVendor,
};

/** Keyed by the exact specifier `crypto.ts` imports (see that file); never touched by user code directly. */
const INTERNAL_VENDOR_TABLE: Record<string, string> = {
  "./vendor/create-hash-entry": createHashVendor,
  "./vendor/create-hmac-entry": createHmacVendor,
};

/**
 * The `process.env` snapshot (spec §5.13, "constraint most likely to be got wrong" per the Task 10 brief): reuses
 * `runnerEnvironment` verbatim -- the same layering and reserved-key stripping (no `JSLAB_*`, no `BUN_OPTIONS`) the
 * Bun runtime's own runner process gets (`apps/desktop/src/main/runs/runner-config.ts`). `base` is Main's own
 * `process.env`, which *is* the login-shell environment (spec §4.6): Main never re-execs, so its own `process.env`
 * at bundle time is byte-for-byte what `apps/desktop/src/main/index.ts` captured at launch and threads through as
 * `MainServicesOptions.env` everywhere else. `env.json` (`variables`) and a working directory's `.env` (`dotenv`)
 * are not layered in here: `WebAdapterDeps` does not yet carry them through to `bundleAppForWeb`/`bundleVendorForWeb`
 * (the registry only wires up the `bun` adapter so far -- `main-services.ts`'s own note on this), so there is
 * nothing to layer from this seam today. A future task that wires the real `browser-node` production adapter
 * should extend `BrowserNodeContext` with `variables`/`dotenv` and pass them straight through to `runnerEnvironment`
 * here, rather than inventing a second builder.
 */
function browserNodeEnv(ctx: BrowserNodeContext): Record<string, string> {
  return runnerEnvironment(
    { packagesNodeModules: ctx.packagesNodeModules },
    { base: process.env, workingDirectory: ctx.workingDirectory },
  );
}

/**
 * `process.ts` exports only the pure factory (see its own comment); this appends the lines that instantiate it
 * with a real, bundle-time snapshot -- computed fresh on every call, matching the app chunk's own "rebuilt on
 * every run without exception" rule (`bundler.ts`), so this is effectively a page-load snapshot.
 *
 * Fix round 1 (I1): a default export alone left `import { env } from 'process'` (an ordinary spelling, not an
 * exotic one) failing the build with "no matching export" -- so every `ProcessPolyfill` property also gets its
 * own named export, re-read off the one instantiated object (no second construction, no drift between the two
 * forms). `cwd`/`nextTick` are plain functions that close over `snapshot`, not `this` -- safe to export directly
 * without binding.
 */
function processModuleSource(ctx: BrowserNodeContext): string {
  const snapshot = {
    env: browserNodeEnv(ctx),
    cwd: ctx.workingDirectory ?? process.cwd(),
    platform: process.platform,
    // No real argv exists for a page: this mirrors the shape of a Bun runner's own argv (execPath, entry) closely
    // enough for code that merely checks `process.argv.length` or logs it, without pretending to a real script path.
    argv: [process.execPath, "jslab-tab"],
    versions: { ...process.versions },
  };
  return [
    processSrc,
    `const __jslabProcess = createProcessPolyfill(${JSON.stringify(snapshot)});`,
    "export default __jslabProcess;",
    "export const env = __jslabProcess.env;",
    "export const platform = __jslabProcess.platform;",
    "export const argv = __jslabProcess.argv;",
    "export const versions = __jslabProcess.versions;",
    "export const version = __jslabProcess.version;",
    "export const cwd = __jslabProcess.cwd;",
    "export const nextTick = __jslabProcess.nextTick;",
    "export const browser = __jslabProcess.browser;",
    "",
  ].join("\n");
}

/**
 * Same pattern as `processModuleSource`: `os.ts` exports only the pure factory; this appends the instantiation,
 * built from Main's own `node:os` at bundle time (spec §5.13: "snapshot values (sync)") -- plus, per fix round 1
 * (I1), one named export per `OsPolyfill` property so `import { platform } from 'os'` works exactly like
 * `import osMod from 'os'; osMod.platform()` does. Every property here is a function that closes over `snapshot`
 * (see `os.ts`), so re-exporting it directly is safe -- none of them reference `this`.
 */
function osModuleSource(): string {
  const snapshot = {
    arch: nodeOs.arch(),
    platform: nodeOs.platform(),
    release: nodeOs.release(),
    type: nodeOs.type(),
    version: nodeOs.version(),
    homedir: nodeOs.homedir(),
    tmpdir: nodeOs.tmpdir(),
    hostname: nodeOs.hostname(),
    endianness: nodeOs.endianness(),
    eol: nodeOs.EOL,
    cpus: nodeOs.cpus().map((cpu) => ({ model: cpu.model, speed: cpu.speed })),
    totalmem: nodeOs.totalmem(),
    freemem: nodeOs.freemem(),
  };
  return [
    osSrc,
    `const __jslabOs = createOsPolyfill(${JSON.stringify(snapshot)});`,
    "export default __jslabOs;",
    "export const arch = __jslabOs.arch;",
    "export const platform = __jslabOs.platform;",
    "export const release = __jslabOs.release;",
    "export const type = __jslabOs.type;",
    "export const version = __jslabOs.version;",
    "export const homedir = __jslabOs.homedir;",
    "export const tmpdir = __jslabOs.tmpdir;",
    "export const hostname = __jslabOs.hostname;",
    "export const endianness = __jslabOs.endianness;",
    "export const EOL = __jslabOs.EOL;",
    "export const cpus = __jslabOs.cpus;",
    "export const totalmem = __jslabOs.totalmem;",
    "export const freemem = __jslabOs.freemem;",
    "",
  ].join("\n");
}

/** The virtual namespace every `browser-node` module table entry loads under (real user files never enter it). */
const NAMESPACE = "jslab-node-polyfill";

/**
 * `nodePolyfills` (spec §5.12): the second of `Bun.build`'s three plugins, the §5.13 Node-builtin table.
 *
 * - `browser` has no Node builtins at all (confirmed by measurement: left unhandled, `Bun.build({target:'browser'})`
 *   silently stubs an unresolved builtin rather than failing the build -- which would hide a real problem from the
 *   user at bundle time only to surface it as a confusing runtime error later). So every builtin bare specifier is
 *   explicitly caught here and turned into an install-assist-shaped `BundleError` (`specifier` set; §11.4's own
 *   "node: and built-ins are ignored" rule keeps install-assist from offering to install it) reported through
 *   `onError` before the plugin forces the build to fail. The position/code-frame is recovered by `locateImport`
 *   (a direct scan of the importing file for the real import, not just the first quoted occurrence of the
 *   specifier text -- fix round 1, M1), since forcing a Bun.build failure from a plugin callback (throwing, or
 *   resolving to a path that can't load) discards whatever `position`/`specifier` Bun would otherwise have
 *   attached to the resulting `BuildMessage` (measured: both come back empty).
 * - `browser-node` (Task 10) resolves the §5.13 module table: `buffer, path, events, util, url, querystring,
 *   string_decoder, assert, stream, punycode` (bundled sync and full, pre-flattened real polyfills -- see the
 *   vendor files), `process`/`os` (a page-load snapshot, computed here and appended to the pure factory in
 *   `packages/runner-web/src/polyfills/{process,os}.ts`), and `crypto` (native `webcrypto` plus a polyfilled
 *   `createHash`/`createHmac`, `packages/runner-web/src/polyfills/crypto.ts`). `fs`, `child_process` and the
 *   throw-only builtins (`http`, `net`, `tls`, `dgram`, `worker_threads`, `vm`) are Task 11's async bridge, not
 *   this table -- an import of one of those still falls through unhandled here, exactly as it did before this task
 *   (unchanged scope, per the Task 10 brief).
 *
 * `jslabResolve` (the plugin registered before this one) already defers a bare specifier it recognizes as a Node
 * builtin -- returning `undefined` instead of failing it -- specifically so this plugin still gets to produce its
 * own, more specific error for it (fix round 1, C1). The same deferral is what lets the §5.13 table below actually
 * receive `buffer`/`path`/etc.: `isNodeBuiltin` is true for all ten, so `jslabResolve` never touches them.
 */
export function nodePolyfills(
  runtime: Runtime,
  onError: (error: BundleError) => void,
  browserNode?: BrowserNodeContext,
): BunPlugin {
  return {
    name: "jslab-node-polyfills",
    setup(build) {
      if (runtime === "browser") {
        build.onResolve({ filter: /^[^./]/ }, (args) => {
          if (!isNodeBuiltin(args.path)) return undefined;
          let location: ReturnType<typeof locateImport>;
          try {
            location = locateImport(readFileSync(args.importer, "utf8"), args.path);
          } catch {
            // best effort only; fall back to an unpositioned error below
          }
          onError({
            message: `Cannot find module '${args.path}'. Node built-ins aren't available in the Browser runtime.`,
            specifier: args.path,
            ...(location
              ? {
                  line: location.line,
                  column: location.column,
                  codeFrame: buildCodeFrame(location.lineText, location.column),
                }
              : {}),
          });
          // Forces Bun.build to fail; the caller uses the `BundleError` captured by `onError` above, not whatever
          // this produces in `result.logs`/the thrown `AggregateError` (which carries no useful position here).
          throw new Error(`jslab: blocked Node builtin "${args.path}"`);
        });
        return;
      }

      if (runtime !== "browser-node") return;
      const ctx: BrowserNodeContext = browserNode ?? { workingDirectory: null, packagesNodeModules: "" };

      // The ten sync builtins, `process`, `os` and `crypto` -- the top-level bare specifiers a tab (or a vendored
      // npm package) can import directly, `node:`-prefixed or not. `isNodeBuiltin` already gated everything
      // reaching this plugin (see the doc comment above), so a plain key lookup on the *normalized* name is exact
      // -- no risk of catching an unrelated bare specifier. Fix round 1 (I2): normalizing through `stripNodePrefix`
      // (the same function `isNodeBuiltin` uses) is what makes `node:path`/`node:buffer`/`node:process` resolve to
      // this table instead of bypassing it -- measured, before this fix, to produce three different wrong outcomes
      // (two silently wrong, one a confusing hard error; see the Task 10 fix-round-1 report). The resolved `path`
      // is the normalized (unprefixed) name, so `onLoad` below never needs to know which spelling was used.
      build.onResolve({ filter: /^[^./]/ }, (args) => {
        const bare = stripNodePrefix(args.path);
        if (bare in VENDOR_TABLE || bare === "process" || bare === "os" || bare === "crypto") {
          return { path: bare, namespace: NAMESPACE };
        }
        return undefined;
      });

      // `crypto.ts`'s own two relative imports (its `createHash`/`createHmac` vendor entries). Scoped to imports
      // made *from inside* the plugin's own virtual `crypto` module (`args.importer === "crypto"`) so a real
      // relative import in a tab's own code is never touched. Measured, not assumed: `args.namespace` here reflects
      // the *specifier's own* default resolution namespace ("file"), not the importer's namespace -- unlike
      // `resolve-plugin.ts`'s `VENDOR_STUB_NAMESPACE` check (a namespace check works there because that stub
      // content is loaded under a namespace with no further imports of its own to resolve). `args.importer` is the
      // one field that reliably names which virtual module is doing the importing.
      build.onResolve({ filter: /.*/ }, (args) => {
        if (args.importer !== "crypto") return undefined;
        if (!(args.path in INTERNAL_VENDOR_TABLE)) return undefined;
        return { path: args.path, namespace: NAMESPACE };
      });

      build.onLoad({ filter: /.*/, namespace: NAMESPACE }, (args) => {
        const vendor = VENDOR_TABLE[args.path] ?? INTERNAL_VENDOR_TABLE[args.path];
        if (vendor !== undefined) return { contents: vendor, loader: "js" };
        if (args.path === "process") return { contents: processModuleSource(ctx), loader: "ts" };
        if (args.path === "os") return { contents: osModuleSource(), loader: "ts" };
        if (args.path === "crypto") return { contents: cryptoSrc, loader: "ts" };
        return undefined;
      });
    },
  };
}
