import type { Runtime } from "@jslab/shared";
import type { BunPlugin } from "bun";
import { cssInject } from "./css-plugin";
import { buildCodeFrame } from "./locate-import";
import { nodePolyfills } from "./polyfill-plugin";
import { jslabResolve, VENDOR_REGISTRY_GLOBAL } from "./resolve-plugin";

export interface BundleOptions {
  /** Absolute path to the per-run entry file (already transpiled -- the bundler resolves and packages it). */
  entry: string;
  runtime: Runtime;
  /** The tab's working directory, or null when none is set (spec §5.3). */
  workingDirectory: string | null;
  /** `apps/desktop/src/main/app-paths.ts:46`'s `packagesNodeModules`. */
  packagesNodeModules: string;
}

/** What the vendor half of a run needs: the packages the app chunk named, and where to resolve them from. */
export interface VendorBundleOptions extends Omit<BundleOptions, "entry"> {
  /** `AppBundle.imports`, verbatim -- the set the cache key is built from (spec §5.12). */
  imports: readonly string[];
}

/**
 * One bundle failure, presented like a transpile failure (spec §5.11): one error entry with a code frame, feeding
 * the same install-assist path (§11.4) transpile/runtime module-not-found errors already do. `specifier` is a
 * field of its own, not just folded into `message` -- Task 5's brief pins this exactly, since deriving `@a/b` from
 * `@a/b/c` (§11.4) needs the raw specifier text, not a substring match against prose.
 */
export interface BundleError {
  message: string;
  specifier?: string;
  line?: number;
  column?: number;
  codeFrame?: string;
}

/**
 * The tab's own code, and nothing else (Task 8a). `imports` is the set of bare (npm-style) specifiers
 * `jslabResolve` actually resolved -- the vendor cache keys its chunk on exactly this set plus the `bun.lock`
 * hash, so it has to travel with the result rather than be re-derived later.
 *
 * `vendorCacheable` is false when any of those imports resolved out of the tab's working directory instead of the
 * shared packages folder. The key's lockfile half describes the packages folder and only the packages folder, so a
 * chunk containing working-directory code could change underneath a key that never moved -- the caller must
 * neither store nor serve one (`web-adapter.ts`).
 */
export interface AppBundle {
  code: string;
  map: string;
  imports: string[];
  vendorCacheable: boolean;
}

export type AppBundleResult = AppBundle | { error: BundleError };

/** The third-party half: one chunk that publishes every package into the page-global registry. */
export type VendorBundleResult = { code: string; map: string } | { error: BundleError };

interface BunResolveOrBuildMessage {
  name?: string;
  message?: string;
  specifier?: string;
  position?: { line: number; column: number; lineText: string } | null;
}

/**
 * Bun.build's own resolve failure (a `ResolveMessage`) already carries the specifier and an accurate source
 * position (`position.line`/`position.column`, 0-indexed, plus `position.lineText`) -- there's no need to
 * reconstruct any of that ourselves for an ordinary missing package. Column is normalized to 1-indexed to match
 * `Diagnostic.column` (`packages/transform/src/types.ts`), which the rest of the app's error presentation expects.
 */
function fromBuildFailure(error: unknown): BundleError {
  const errors = (error as { errors?: BunResolveOrBuildMessage[] } | undefined)?.errors;
  const first = errors?.[0];
  if (!first) return { message: error instanceof Error ? error.message : String(error) };
  const position = first.position;
  return {
    message: first.message ?? "Bundle failed",
    ...(first.specifier ? { specifier: first.specifier } : {}),
    ...(position ? { line: position.line, column: position.column + 1 } : {}),
    ...(position?.lineText ? { codeFrame: buildCodeFrame(position.lineText, position.column + 1) } : {}),
  };
}

/**
 * `bundleAppForWeb` (spec §5.12, §5.11): turns one tab's transpiled entry into a browser-runnable module carrying
 * the tab's own code only. `Bun.build({target:'browser', format:'esm', sourcemap:'external'})`, with the three
 * plugins in the spec's exact order -- `jslabResolve` (npm resolution, WD first), `nodePolyfills` (the §5.13
 * Node-builtin table/seam), then `cssInject` (stylesheet imports).
 *
 * Task 8a: `jslabResolve` runs in stub mode here, so a resolved package becomes a one-line stub reading the vendor
 * registry instead of the package's own source. Resolution itself is unchanged -- the same working-directory-first
 * precedence, the same containment check against Bun's ancestor walk, and the same install-assist-shaped error for
 * a specifier that resolves nowhere -- because the app build is still the only place the user's own import
 * statements are read, and therefore still the only place those errors can be positioned in their source.
 */
export async function bundleAppForWeb(options: BundleOptions): Promise<AppBundleResult> {
  const resolvedImports = new Set<string>();
  const workingDirectoryImports = new Set<string>();
  let capturedError: BundleError | null = null;

  try {
    const result = await Bun.build({
      entrypoints: [options.entry],
      target: "browser",
      format: "esm",
      sourcemap: "external",
      plugins: [
        jslabResolve(
          { workingDirectory: options.workingDirectory, packagesNodeModules: options.packagesNodeModules },
          resolvedImports,
          (error) => {
            capturedError ??= error;
          },
          { workingDirectoryImports },
        ),
        nodePolyfills(options.runtime, (error) => {
          capturedError ??= error;
        }),
        cssInject(),
      ],
    });

    const codeOutput = result.outputs.find((output) => output.kind === "entry-point");
    const mapOutput = result.outputs.find((output) => output.kind === "sourcemap");
    return {
      code: codeOutput ? await codeOutput.text() : "",
      map: mapOutput ? await mapOutput.text() : "",
      imports: [...resolvedImports],
      vendorCacheable: workingDirectoryImports.size === 0,
    };
  } catch (error) {
    // A plugin (`jslabResolve` for an unresolved bare specifier, `nodePolyfills` for a blocked Node builtin) may
    // have already captured a richer error than whatever `Bun.build`'s own thrown `AggregateError` carries here --
    // that one wins (spec §5.11: one entry). The fallback below still matters for a failure neither plugin caused
    // (e.g. a genuine syntax error in a locally-resolved file).
    return { error: capturedError ?? fromBuildFailure(error) };
  }
}

/** Where the synthetic vendor entry lives. Virtual: a plugin serves it, so no file is ever written for it. */
const VENDOR_ENTRY_PATH = "jslab-vendor-entry";
const VENDOR_ENTRY_NAMESPACE = "jslab-vendor-entry";

/**
 * Bridges what a package exports to what an app-chunk stub must expose, so that the split is invisible to the
 * user's import statements. It runs inside the page, once per package, on the namespace of the real module.
 *
 * - **A CommonJS package** (React and most of npm): Bun's namespace for one is `module.exports` under `default`
 *   with its properties copied alongside, so every non-default key already exists on the default. Handing back
 *   `default` itself reproduces an unsplit build exactly -- `import React from "react"` is `module.exports`, and
 *   `import { useState } from "react"` is a property of it, which is what Bun compiles a CommonJS named import to
 *   anyway.
 * - **An ES module with named exports of its own**: `default` and the named exports are genuinely different
 *   things, and no single object is both. The proxy answers for the named exports and defers everything else to
 *   the default export, so `import chalk from "chalk"` and `import { Chalk } from "chalk"` both land correctly.
 *   The one measured divergence from an unsplit build: `import * as ns` over such a package also enumerates the
 *   default export's own keys, since the proxy has to keep them reachable. Values are identical either way; only
 *   `Object.keys(ns)` differs.
 * - **A named-only ES module** (no `default` export at all): the namespace itself is the answer, and named imports
 *   read straight off it.
 * - **A primitive default** (`export default "some string"`): the primitive is handed back as-is, so the default
 *   import is exact. Nothing can carry both a primitive and named exports, and a package shaped that way is rare
 *   enough that default fidelity is the right thing to keep.
 */
const VENDOR_INTEROP_SOURCE = [
  "function __jslabInterop(ns) {",
  '  if (!("default" in ns)) return ns;',
  "  var d = ns.default;",
  '  if ((typeof d !== "object" || d === null) && typeof d !== "function") return d;',
  '  var extra = Object.keys(ns).filter(function (k) { return k !== "default" && !(k in d); });',
  "  if (extra.length === 0) return d;",
  "  return new Proxy(d, {",
  "    get: function (t, k, r) { return extra.indexOf(k) >= 0 ? ns[k] : Reflect.get(t, k, r); },",
  "    has: function (t, k) { return extra.indexOf(k) >= 0 || Reflect.has(t, k); },",
  "    ownKeys: function (t) { return Array.from(new Set(Reflect.ownKeys(t).concat(extra))); },",
  "    getOwnPropertyDescriptor: function (t, k) {",
  "      if (extra.indexOf(k) >= 0 && !Reflect.getOwnPropertyDescriptor(t, k))",
  "        return { value: ns[k], enumerable: true, configurable: true, writable: false };",
  "      return Reflect.getOwnPropertyDescriptor(t, k);",
  "    },",
  "  });",
  "}",
].join("\n");

/** The synthetic entry the vendor build bundles: import every package, publish each into the page-global registry. */
function vendorEntrySource(imports: readonly string[]): string {
  const names = [...imports].sort();
  return [
    ...names.map((name, index) => `import * as m${index} from ${JSON.stringify(name)};`),
    VENDOR_INTEROP_SOURCE,
    `var __reg = (globalThis.${VENDOR_REGISTRY_GLOBAL} = globalThis.${VENDOR_REGISTRY_GLOBAL} || {});`,
    ...names.map((name, index) => `__reg[${JSON.stringify(name)}] = __jslabInterop(m${index});`),
    "",
  ].join("\n");
}

/** Serves the synthetic vendor entry from memory; `resolveDir` is what any relative import inside it would use. */
function vendorEntryPlugin(source: string, resolveDir: string): BunPlugin {
  return {
    name: "jslab-vendor-entry",
    setup(build) {
      build.onResolve({ filter: /^jslab-vendor-entry$/ }, () => ({
        path: VENDOR_ENTRY_PATH,
        namespace: VENDOR_ENTRY_NAMESPACE,
      }));
      build.onLoad({ filter: /.*/, namespace: VENDOR_ENTRY_NAMESPACE }, () => ({
        contents: source,
        loader: "js",
        resolveDir,
      }));
    },
  };
}

/**
 * `bundleVendorForWeb` (spec §5.12): the third-party half of a run, and the only half the cache ever holds. Its
 * content is fully described by the packages named in `imports` plus the versions `bun.lock` pins -- which is
 * exactly what the cache key is made of, and exactly why this half, and only this half, can be reused across runs.
 *
 * Package code reaches the page through this chunk alone, so `cssInject` runs here too: a stylesheet imported by a
 * package is injected from the vendor chunk, not the app chunk.
 */
export async function bundleVendorForWeb(options: VendorBundleOptions): Promise<VendorBundleResult> {
  if (options.imports.length === 0) return { code: "", map: "" };
  const resolvedImports = new Set<string>();
  let capturedError: BundleError | null = null;

  try {
    const result = await Bun.build({
      entrypoints: [VENDOR_ENTRY_PATH],
      target: "browser",
      format: "esm",
      sourcemap: "external",
      plugins: [
        vendorEntryPlugin(vendorEntrySource(options.imports), options.workingDirectory ?? options.packagesNodeModules),
        jslabResolve(
          { workingDirectory: options.workingDirectory, packagesNodeModules: options.packagesNodeModules },
          resolvedImports,
          (error) => {
            capturedError ??= error;
          },
        ),
        nodePolyfills(options.runtime, (error) => {
          capturedError ??= error;
        }),
        cssInject(),
      ],
    });

    const codeOutput = result.outputs.find((output) => output.kind === "entry-point");
    const mapOutput = result.outputs.find((output) => output.kind === "sourcemap");
    return { code: codeOutput ? await codeOutput.text() : "", map: mapOutput ? await mapOutput.text() : "" };
  } catch (error) {
    return { error: capturedError ?? fromBuildFailure(error) };
  }
}

/**
 * Joins the two halves into the single module the page runs (spec §5.12 step 4: one `import()` of one blob).
 *
 * The vendor chunk runs first, inside its own function scope, and publishes only through the registry global.
 * The scope is the point: the two halves come out of two independent `Bun.build` calls, each naming its own
 * top-level bindings, and a user writing `const React = ...` at the top level of their own file must never collide
 * with a name the vendor chunk happened to pick. Wrapping the vendor half means nothing it declares is even
 * visible to the app half -- the registry is the whole interface between them.
 *
 * The wrapper is `async` and awaited so that a package doing top-level `await` still settles before the app code
 * that imports it runs, exactly as it would have in an unsplit bundle.
 */
export function joinVendorAndApp(vendorCode: string | null, appCode: string): string {
  if (!vendorCode) return appCode;
  return `await (async () => {\n${vendorCode}\n})();\n${appCode}`;
}
