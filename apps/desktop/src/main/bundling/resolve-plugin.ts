import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import type { BunPlugin } from "bun";
import { MAX_PACKAGE_JSON_BYTES, readBoundedTextSyncOrNull } from "../fs/bounded-read";
import type { BundleError } from "./bundler";
import { buildCodeFrame, locateImport } from "./locate-import";
import { isNodeBuiltin } from "./node-builtins";

/** Bare (npm-style) specifiers only: not relative (`./`, `../`), not absolute (`/`). */
const BARE_SPECIFIER = /^[^./]/;

/**
 * Task 8a (the vendor/app split): the page-global the vendor chunk publishes each package into, and that every
 * app-chunk stub reads back out of. One global for the whole page, filled before the app chunk's first line runs
 * (see `joinVendorAndApp` in `bundler.ts`).
 */
export const VENDOR_REGISTRY_GLOBAL = "__jslabVendor";

/** The build namespace the app build's package stubs live in; nothing outside this file needs to name it. */
const VENDOR_STUB_NAMESPACE = "jslab-vendor";

/** The build namespace a package excluded by a `browser` map's `false` is served from, as an empty module. */
const BROWSER_EXCLUDED_NAMESPACE = "jslab-browser-excluded";

export interface ResolveOptions {
  /**
   * Collects every specifier that resolved out of the tab's own working directory rather than the shared packages
   * folder. `bun.lock` describes only the packages folder, so a vendor chunk built from anything else cannot be
   * keyed safely -- see `AppBundle.vendorCacheable` and `VendorBundle.vendorCacheable`.
   *
   * Fix round 1 (C1): tracking used to be welded to stub mode, so only the *app* build reported provenance -- and
   * the app build only ever resolves a tab's **direct** imports. `resolveBareSpecifier` tries the working
   * directory first in every build, so a package resolved from the shared folder whose own dependency resolved out
   * of the working directory produced a vendor chunk full of working-directory code that was still marked
   * cacheable. Tracking is now independent of stub mode, so the vendor build -- the build where every transitive
   * specifier is resolved -- reports provenance too.
   */
  workingDirectoryImports?: Set<string>;
  /**
   * App build only: resolve a package to a registry stub instead of to its own source, which is what keeps package
   * code out of the app chunk (the vendor/app split).
   */
  vendorStubs?: boolean;
}

/**
 * One package's stub in the app chunk. Deliberately CommonJS: a stub's named exports are only known at runtime
 * (they are whatever the real package turns out to export), and CommonJS is the one module shape whose named
 * imports Bun compiles to a property read instead of a link-time check. An ES-module stub would have to list every
 * export name at build time, which is exactly what a pre-built vendor chunk cannot tell us -- measured: Bun emits
 * a CommonJS package's split chunk with `export default` and nothing else, so `import { useState } from "react"`
 * across a real chunk boundary fails to link.
 */
function vendorStubSource(specifier: string): string {
  return `module.exports = globalThis.${VENDOR_REGISTRY_GLOBAL}[${JSON.stringify(specifier)}];\n`;
}

/**
 * Whether `resolved` came out of `workingDirectory`'s own `node_modules`. Both sides go through `realpathSync` for
 * the same reason `resolveBareSpecifier` does it (macOS `$TMPDIR` runs through `/var` -> `/private/var`, and Bun's
 * own canonicalization of a resolved path is not consistent call to call).
 */
export function resolvedFromWorkingDirectory(resolved: string, workingDirectory: string | null): boolean {
  if (!workingDirectory) return false;
  try {
    return realpathSync(resolved).startsWith(join(realpathSync(workingDirectory), "node_modules") + sep);
  } catch {
    return false;
  }
}

export interface ResolveContext {
  /** The tab's working directory, or null when none is set (spec §5.3). */
  workingDirectory: string | null;
  /** `apps/desktop/src/main/app-paths.ts:46`'s `packagesNodeModules` -- the shared packages `node_modules` itself. */
  packagesNodeModules: string;
}

/** Which spelling of the ESM/CommonJS condition pair a resolution matches, chosen by the importing syntax. */
export type ResolutionKind = "import" | "require";

/**
 * The conditions a browser-targeted build matches, for one resolution kind. `node` is deliberately absent:
 * selecting it is exactly the defect the functions below exist to close.
 *
 * `require` vs `import` is picked from the **kind of the importing syntax** rather than hardcoded, because Bun does
 * exactly that and the two answers genuinely differ. Measured with no plugin in the build at all, on
 * `exports: {".": {require: {browser: "./rb.js", default: "./rn.js"}, import: "./i.js", default: "./index.js"}}`:
 * `require("pkg")` bundles `./rb.js`, while `import ... from "pkg"` bundles `./i.js`. The set used to be fixed at
 * the `import` spelling, so a `require()`-kind resolution was handed the `import` branch, and a package whose only
 * browser entry hangs under `require` lost it silently.
 *
 * `module` stays on the `import` side alone: it is an ESM-only convention, so matching it for a CommonJS request
 * would hand a `require()` an ES module.
 *
 * Membership is tested against the **package's own key order**, never this set's, because the `exports` algorithm
 * is "the first key of the object that the active condition set matches" -- a package listing `default` before
 * `browser` means it, and reordering it here would be a different (wrong) answer.
 */
function browserConditions(kind: ResolutionKind): Set<string> {
  return kind === "require"
    ? new Set(["browser", "require", "default"])
    : new Set(["browser", "import", "module", "default"]);
}

/** An `exports` object is a subpath map only when it is keyed by subpaths; otherwise it is a condition map for `.`. */
function isSubpathMap(exports: Record<string, unknown>): boolean {
  return Object.keys(exports).some((key) => key.startsWith("."));
}

/**
 * Whether a `browser` condition appears anywhere in this export target. This is the **gate** on overriding at all:
 * a package that never mentions `browser` keeps `Bun.resolveSync`'s answer byte for byte, so the overwhelming
 * majority of packages resolve exactly as they did before this fix and cannot be repointed by it.
 */
function declaresBrowserCondition(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(declaresBrowserCondition);
  if (node && typeof node === "object") {
    return Object.entries(node as Record<string, unknown>).some(
      ([key, value]) => key === "browser" || declaresBrowserCondition(value),
    );
  }
  return false;
}

/**
 * Walks an export target under `conditions`, returning the first candidate `accept` confirms as a real file inside
 * the package.
 *
 * Threading `accept` through the walk -- rather than returning the first string and checking it afterwards -- is
 * what makes an **array** target behave like the fallback list the `exports` spec says it is. Before this, the
 * first array member was returned unconditionally; if that member did not exist, the existence check downstream
 * failed and abandoned the *whole* override, so `{browser: ["./missing.js", "./b.js"]}` fell back to the package's
 * node entry instead of `./b.js`.
 *
 * Every rejection is a fall-through to the next candidate, and a walk that confirms nothing leaves the caller with
 * Bun's original answer. That makes the override fail-safe by construction: it can only ever repoint a specifier at
 * a file that exists inside the package, and can never turn a build that would have succeeded into one that fails.
 */
function selectBrowserTarget(
  node: unknown,
  conditions: Set<string>,
  accept: (relative: string) => string | undefined,
): string | undefined {
  if (typeof node === "string") return accept(node);
  if (Array.isArray(node)) {
    for (const candidate of node) {
      const selected = selectBrowserTarget(candidate, conditions, accept);
      if (selected !== undefined) return selected;
    }
    return undefined;
  }
  if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (!conditions.has(key)) continue;
      const selected = selectBrowserTarget(value, conditions, accept);
      if (selected !== undefined) return selected;
    }
  }
  return undefined;
}

/** Splits `@scope/name/sub` into its package name and the `.`-relative subpath an `exports` map is keyed by. */
function splitSpecifier(specifier: string): { packageName: string; subpath: string } {
  const segments = specifier.split("/");
  const nameSegments = specifier.startsWith("@") ? 2 : 1;
  const rest = segments.slice(nameSegments).join("/");
  return { packageName: segments.slice(0, nameSegments).join("/"), subpath: rest ? `./${rest}` : "." };
}

/**
 * The export target for one subpath: an exact key, else the `*` pattern key that matches (with what `*` captured).
 *
 * Pattern keys are tried **most specific first**, not in the object's own key order, because that is what the
 * `exports` spec prescribes (`PATTERN_KEY_COMPARE`: longer literal prefix wins, then longer suffix) and what Bun
 * implements. Measured with no plugin at all, on
 * `{"./*": {browser: "./b/*.js"}, "./feature/*": {browser: "./fb/*.js"}}` importing `pkg/feature/x`: Bun bundles
 * `./fb/x.js`. First-match-in-key-order returned `./b/feature/x.js` instead -- silently the wrong file, and only
 * when a package happened to list its general pattern above its specific one. Key order is now irrelevant, also
 * measured: the same fixture with the two keys swapped resolves identically under Bun and here.
 *
 * Note that an exact key still beats every pattern, which is the spec's ordering too.
 */
function exportsEntryFor(
  exports: Record<string, unknown>,
  subpath: string,
): { target: unknown; star: string | null } | undefined {
  if (!isSubpathMap(exports)) return subpath === "." ? { target: exports, star: null } : undefined;
  if (exports[subpath] !== undefined) return { target: exports[subpath], star: null };
  const patterns = Object.entries(exports)
    .flatMap(([key, value]) => {
      const starIndex = key.indexOf("*");
      if (starIndex < 0) return [];
      return [{ value, prefix: key.slice(0, starIndex), suffix: key.slice(starIndex + 1) }];
    })
    .sort((a, b) => b.prefix.length - a.prefix.length || b.suffix.length - a.suffix.length);
  for (const { value, prefix, suffix } of patterns) {
    if (subpath.length < prefix.length + suffix.length) continue;
    if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) continue;
    return { target: value, star: subpath.slice(prefix.length, subpath.length - suffix.length) };
  }
  return undefined;
}

/**
 * The `browser` map's entry for `file`, or undefined when the map does not name it.
 *
 * Keys are package-relative paths, compared with a leading `./` optional on either side: measured, a plain
 * browser-target build honours `{"index.js": "./index.browser.js"}` exactly as it honours the `./`-prefixed
 * spelling.
 *
 * Keys that name a **module** rather than a file (`{"fs": false}`, `{"crypto": "./shim.js"}`) are deliberately not
 * handled here. Those rewrite imports made from *inside* the package, which never reach this plugin -- its hook
 * only ever sees a bare specifier, and a package's own relative imports are resolved by Bun. Measured, with the
 * package entry handed to Bun as a concrete path by a plugin exactly as `jslabResolve` hands it over: Bun still
 * rewrote the package's internal `./internal.js` import through the map, and still dropped a file the map set to
 * `false`. So that half of the field already works, and duplicating it here could only introduce disagreement.
 */
function browserMapTarget(map: Record<string, unknown>, packageRoot: string, file: string): string | false | undefined {
  if (!file.startsWith(packageRoot + sep)) return undefined;
  const relative = file
    .slice(packageRoot.length + 1)
    .split(sep)
    .join("/");
  for (const [key, value] of Object.entries(map)) {
    if (key.replace(/^\.\//, "") !== relative) continue;
    if (value === false) return false;
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
}

/** What `resolveBareSpecifier` decided about one bare specifier. */
export interface ResolvedSpecifier {
  /** The file to bundle -- or, when `excluded`, the file Bun resolved, kept so provenance stays accurate. */
  path: string;
  /** The package's `browser` map sends this entry to `false`: bundle an empty module instead of `path`. */
  excluded: boolean;
}

/**
 * The entry a browser-targeted build would have chosen for `specifier`, or undefined to keep the path
 * `Bun.resolveSync` already produced.
 *
 * **Why this exists.** `resolveBareSpecifier` resolves through `Bun.resolveSync`, which is Bun's *runtime*
 * resolver: it has no `browser` condition, so it takes the `node`/`default` branch of an `exports` map. Because
 * `jslabResolve` then hands `Bun.build` a concrete **file path**, `Bun.build({target:"browser"})` never gets the
 * chance to apply the browser resolution it would have chosen on its own -- the plugin has already decided.
 *
 * Reported as `import { nanoid } from 'nanoid'` failing in a browser tab with
 * `ReferenceError: Can't find variable: Buffer`: nanoid@6.0.1's `exports["."]` is
 * `{ browser: "./index.browser.js", default: "./index.js" }`, and its `default` entry calls `Buffer.allocUnsafe`.
 * That `Buffer` is a **free global rather than an import**, so `nodePolyfills`'s builtin-blocking resolve hook
 * never sees it and the build succeeds -- the failure lands at run time in the page instead of at bundle time.
 *
 * **Both of a package's browser declarations are honoured, because Bun honours both.** An earlier round of this fix
 * recorded that Bun ignores the top-level `browser` field and that reading it here would make JSLab diverge from
 * Bun. That measurement was wrong, and it was load-bearing: nanoid declares a `browser` map as well as its
 * `exports` condition, so real Bun had two defences against a browser-hostile entry and this plugin was defeating
 * both. Re-measured with **no plugin in the build at all**, every case below is what a plain
 * `Bun.build({target:"browser"})` produces:
 *
 * - `{"main":"./index.js","browser":"./index.browser.js"}` bundles the **browser** entry.
 * - `{"main":"./index.js","browser":{"./index.js":"./index.browser.js"}}` bundles the **browser** entry.
 * - the string form is superseded by an `exports` map, exactly as `main` is: with `exports:{".":"./index.js"}`
 *   beside `browser:"./index.browser.js"`, the **node** entry is bundled.
 * - the map form is *not* superseded, because it rewrites whichever file was selected rather than replacing
 *   `main`: with `exports:{".":"./index.js"}` beside `browser:{"./index.js":"./index.browser.js"}`, the
 *   **browser** file is bundled. When an `exports` browser condition already selected some other file, that file
 *   is not a key of the map and the map simply does not fire.
 *
 * That is the order implemented below: resolve the subpath through `exports`, fall back to the string form only
 * when there is no `exports` map at all, then let the map rewrite the result.
 *
 * The override stays gated on the package actually declaring the relevant field, and every candidate must name a
 * real file inside the package. A package that declares neither keeps `Bun.resolveSync`'s answer byte for byte,
 * and nothing this function returns can fail a build that would otherwise have succeeded.
 *
 * **Changing what this function selects obliges you to bump `VENDOR_CACHE_FORMAT`** (`vendor-cache.ts`). A vendor
 * chunk is keyed on the lockfile hash, the import set, the runtime and the working directory -- none of which move
 * when only *resolution* changes -- plus that format tag, which is the one input that can. Without the bump an
 * already-cached chunk stays addressable and is replayed forever: the commit that first fixed the `browser` export
 * condition shipped without it, and users kept getting the node entry's `Buffer.allocUnsafe` out of a stale chunk
 * while the corrected resolver sat unused in the very same build.
 */
export function browserEntryFor(
  specifier: string,
  resolved: string,
  kind: ResolutionKind = "import",
): ResolvedSpecifier | undefined {
  const { packageName, subpath } = splitSpecifier(specifier);
  const marker = `${sep}node_modules${sep}${packageName}${sep}`;
  // `lastIndexOf`, so a nested `node_modules` copy names its own package root rather than an outer one's.
  const index = resolved.lastIndexOf(marker);
  if (index < 0) return undefined;
  const packageRoot = resolved.slice(0, index + marker.length - 1);

  // F4: this read is synchronous and runs on Main's loop during bundling, so an unbounded read blocked it
  // outright and a FIFO never returned at all. The bounded reader refuses both and yields null, which falls
  // through to the same "keep Bun's answer" path an unreadable manifest already took.
  const manifestText = readBoundedTextSyncOrNull(join(packageRoot, "package.json"), MAX_PACKAGE_JSON_BYTES);
  if (manifestText === null) return undefined;
  let manifest: { exports?: unknown; browser?: unknown };
  try {
    manifest = JSON.parse(manifestText) as {
      exports?: unknown;
      browser?: unknown;
    };
  } catch {
    return undefined; // unparseable manifest: keep Bun's answer rather than guess
  }

  // An export or `browser` target must stay inside its own package and must actually exist. Either failing means
  // the manifest describes something this resolver does not understand, and Bun's original answer is the safer one.
  const accept = (relative: string, star: string | null): string | undefined => {
    if (!relative.startsWith("./")) return undefined;
    const candidate = join(packageRoot, star === null ? relative : relative.replaceAll("*", star));
    if (!candidate.startsWith(packageRoot + sep) || !existsSync(candidate)) return undefined;
    return candidate;
  };

  const hasExports = Boolean(manifest.exports) && typeof manifest.exports === "object";
  let selected: string | undefined;
  if (hasExports) {
    const entry = exportsEntryFor(manifest.exports as Record<string, unknown>, subpath);
    if (entry && declaresBrowserCondition(entry.target)) {
      selected = selectBrowserTarget(entry.target, browserConditions(kind), (rel) => accept(rel, entry.star));
    }
  }

  if (selected === undefined && !hasExports && typeof manifest.browser === "string" && subpath === ".") {
    selected = accept(manifest.browser, null);
  }

  if (manifest.browser && typeof manifest.browser === "object" && !Array.isArray(manifest.browser)) {
    const mapped = browserMapTarget(manifest.browser as Record<string, unknown>, packageRoot, selected ?? resolved);
    if (mapped === false) return { path: resolved, excluded: true };
    if (mapped !== undefined) selected = accept(mapped, null) ?? selected;
  }

  return selected === undefined ? undefined : { path: selected, excluded: false };
}

/**
 * Resolves a bare specifier with the same precedence `runnerEnvironment` gives `NODE_PATH` for the Bun runner
 * (`apps/desktop/src/main/app-paths.ts:102-104`): the working directory's `node_modules` first, then the app's
 * shared packages `node_modules`. Returns undefined when neither has it.
 *
 * `Bun.resolveSync` walks up from its `parent` argument through ancestor `node_modules` directories the way Node's
 * own resolver does -- unlike `NODE_PATH`, whose entries are exact directories with no upward walk. The
 * `nodeModulesPrefix` containment check below discards a result that came from outside the intended directory (an
 * unrelated ancestor `node_modules`, or Bun's builtin-module shortcut, which resolves every Node builtin to
 * `node:<name>` from any parent at all) so precedence stays exact. Both sides of the comparison go through
 * `realpathSync` (measured, not assumed): macOS's `$TMPDIR` runs through `/var` -> `/private/var`, and
 * `Bun.resolveSync`'s own canonicalization of its return value turned out inconsistent from call to call in the
 * same process (sometimes realpath'd, sometimes not) -- comparing raw prefixes against it false-negatived a real
 * match, so both `base` and the candidate result are realpath'd here independently rather than trusted from Bun.
 *
 * A caller must never treat `undefined` here as "let something else try" -- see `jslabResolve` below (fix round 1,
 * C1): Bun's own plugin contract treats a plugin's `undefined` as "no opinion, keep trying," and Bun's *own*
 * default resolver does exactly the ancestor walk this containment check exists to defeat.
 */
export function resolveBareSpecifier(
  specifier: string,
  ctx: ResolveContext,
  kind: ResolutionKind = "import",
): ResolvedSpecifier | undefined {
  const candidates = ctx.workingDirectory
    ? [ctx.workingDirectory, dirname(ctx.packagesNodeModules)]
    : [dirname(ctx.packagesNodeModules)];
  for (const base of candidates) {
    let realBase: string;
    try {
      realBase = realpathSync(base);
    } catch {
      continue; // candidate directory doesn't exist
    }
    const nodeModulesPrefix = join(realBase, "node_modules") + sep;
    try {
      const resolved = Bun.resolveSync(specifier, base);
      // The containment check runs against Bun's own answer, so precedence and the ancestor-walk guard are decided
      // exactly as before; `browserEntryFor` only ever repoints within the package that check already accepted.
      if (realpathSync(resolved).startsWith(nodeModulesPrefix)) {
        return browserEntryFor(specifier, resolved, kind) ?? { path: resolved, excluded: false };
      }
    } catch {
      // not found at this candidate; try the next one
    }
  }
  return undefined;
}

/**
 * `jslabResolve` (spec §5.12): the first of `Bun.build`'s three plugins. `resolvedImports` collects every bare
 * specifier this plugin actually resolves -- Task 6's vendor cache keys its chunk on that exact set, so it has to
 * be the resolved (not merely imported) specifiers, matching `BundleResult.imports`.
 *
 * On a miss, this must not return `undefined` (fix round 1, C1): in Bun's plugin contract that means "this plugin
 * has no opinion, keep trying," so Bun's own default resolver -- which does the ancestor `node_modules` walk
 * `resolveBareSpecifier`'s containment check exists to defeat -- got to run next and could resolve (and bundle) a
 * package from a location this plugin explicitly rejected. Reproduced end to end: a package reachable only through
 * an unrelated ancestor `node_modules`, two levels above a nested working directory, was bundled and ran, while
 * `resolveBareSpecifier` called directly for the same layout correctly returned `undefined`. A bare specifier that
 * isn't in either intended directory must never reach Bun's own resolver, so a miss here is reported through
 * `onError` (install-assist-shaped, `specifier` set -- exactly like a genuinely missing package already was) and
 * then forced to fail, mirroring `nodePolyfills`'s existing pattern for a blocked Node builtin.
 *
 * The one exception is a specifier this plugin recognizes as a Node builtin: it's deliberately left as `undefined`
 * (deferred, not failed) so `nodePolyfills`, which runs next in the plugin list, still gets to produce its own more
 * specific "Node built-ins aren't available" error for it rather than this plugin's generic "cannot find module"
 * one. That's safe from the same ancestor-walk leak regardless -- not because of anything `nodePolyfills` does
 * (it returns early unless the runtime is `browser`, `polyfill-plugin.ts:33`, so under `browser-node` it never
 * even registers a resolve hook), but because Bun's own resolver prefers its internal builtin/browser-shim registry
 * over the ancestor `node_modules` walk for a recognised builtin name. Confirmed by fixture: real npm packages
 * named `fs`, `path`, `events` and `punycode`, planted in an ancestor `node_modules`, never won against Bun's
 * builtin resolution, under either runtime.
 */
export function jslabResolve(
  ctx: ResolveContext,
  resolvedImports: Set<string>,
  onError: (error: BundleError) => void,
  options: ResolveOptions = {},
): BunPlugin {
  return {
    name: "jslab-resolve",
    setup(build) {
      if (options.vendorStubs) {
        build.onLoad({ filter: /.*/, namespace: VENDOR_STUB_NAMESPACE }, (args) => ({
          contents: vendorStubSource(args.path),
          loader: "js",
        }));
      }
      // A package whose `browser` map sends its entry to `false` is bundled as an empty module -- the spec's
      // "exclude this module from the browser build" marker, and what a plain browser-target build produces for one
      // (measured: the importer receives `{}`). Registered in every build, not just the stubbed one, because the
      // *vendor* build is where such a package is actually resolved; the app build's stub only reads back whatever
      // the vendor chunk published for it.
      build.onLoad({ filter: /.*/, namespace: BROWSER_EXCLUDED_NAMESPACE }, () => ({
        contents: "module.exports = {};\n",
        loader: "js",
      }));
      build.onResolve({ filter: BARE_SPECIFIER }, (args) => {
        // A stub module imports nothing, so nothing should ever ask to resolve from inside one; ignore it if it
        // does. The same holds for the empty module an excluded package is served as.
        if (args.namespace === VENDOR_STUB_NAMESPACE || args.namespace === BROWSER_EXCLUDED_NAMESPACE) {
          return undefined;
        }
        // `require("pkg")` and `import ... from "pkg"` select different `exports` branches, in Bun and in the spec
        // alike, so the resolution kind decides the condition set rather than being assumed to be `import`.
        const resolved = resolveBareSpecifier(args.path, ctx, args.kind === "require-call" ? "require" : "import");
        if (resolved) {
          resolvedImports.add(args.path);
          // Fix round 1 (C1): recorded for every resolution in every build -- direct or transitive, stubbed or not.
          if (resolvedFromWorkingDirectory(resolved.path, ctx.workingDirectory)) {
            options.workingDirectoryImports?.add(args.path);
          }
          // The app build never reads a line of package code: the specifier becomes a stub that reads whatever the
          // vendor chunk published for it (Task 8a). The specifier itself is the stub's identity, so two imports of
          // the same package share one stub, exactly as they shared one module before the split.
          if (options.vendorStubs) return { path: args.path, namespace: VENDOR_STUB_NAMESPACE };
          if (resolved.excluded) return { path: args.path, namespace: BROWSER_EXCLUDED_NAMESPACE };
          return { path: resolved.path };
        }
        if (isNodeBuiltin(args.path)) return undefined; // nodePolyfills handles this one specifically

        let location: ReturnType<typeof locateImport>;
        try {
          location = locateImport(readFileSync(args.importer, "utf8"), args.path);
        } catch {
          // best effort only; fall back to an unpositioned error below
        }
        onError({
          message: `Cannot find module '${args.path}'. It isn't installed in this project or the shared packages folder.`,
          specifier: args.path,
          ...(location
            ? {
                line: location.line,
                column: location.column,
                codeFrame: buildCodeFrame(location.lineText, location.column),
              }
            : {}),
        });
        // Forces Bun.build to fail rather than falling through to Bun's own (ancestor-walking) default resolver;
        // the caller uses the `BundleError` captured by `onError` above, not whatever this produces downstream.
        throw new Error(`jslab: unresolved bare specifier "${args.path}"`);
      });
    },
  };
}
