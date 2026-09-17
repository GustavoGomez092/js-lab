import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import type { BunPlugin } from "bun";
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

/**
 * The conditions a browser-targeted build matches. `node` is deliberately absent: selecting it is exactly the
 * defect the functions below exist to close.
 *
 * Membership is tested against the **package's own key order**, never this set's, because the `exports` algorithm
 * is "the first key of the object that the active condition set matches" -- a package listing `default` before
 * `browser` means it, and reordering it here would be a different (wrong) answer.
 */
const BROWSER_CONDITIONS = new Set(["browser", "import", "module", "default"]);

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

/** Walks an export target under the browser condition set, returning the first relative path it selects. */
function selectBrowserTarget(node: unknown): string | undefined {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) {
    for (const candidate of node) {
      const selected = selectBrowserTarget(candidate);
      if (selected !== undefined) return selected;
    }
    return undefined;
  }
  if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (!BROWSER_CONDITIONS.has(key)) continue;
      const selected = selectBrowserTarget(value);
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

/** The export target for one subpath: an exact key, else the `*` pattern key that matches (with what `*` captured). */
function exportsEntryFor(
  exports: Record<string, unknown>,
  subpath: string,
): { target: unknown; star: string | null } | undefined {
  if (!isSubpathMap(exports)) return subpath === "." ? { target: exports, star: null } : undefined;
  if (exports[subpath] !== undefined) return { target: exports[subpath], star: null };
  for (const [key, value] of Object.entries(exports)) {
    const starIndex = key.indexOf("*");
    if (starIndex < 0) continue;
    const prefix = key.slice(0, starIndex);
    const suffix = key.slice(starIndex + 1);
    if (subpath.length < prefix.length + suffix.length) continue;
    if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) continue;
    return { target: value, star: subpath.slice(prefix.length, subpath.length - suffix.length) };
  }
  return undefined;
}

/**
 * The `browser` entry a browser-targeted build would have chosen for `specifier`, or undefined to keep the path
 * `Bun.resolveSync` already produced.
 *
 * **Why this exists.** `resolveBareSpecifier` resolves through `Bun.resolveSync`, which is Bun's *runtime*
 * resolver: it has no `browser` condition, so it takes the `node`/`default` branch of an `exports` map. Because
 * `jslabResolve` then hands `Bun.build` a concrete **file path**, `Bun.build({target:"browser"})` never gets the
 * chance to apply the `browser` condition it would have chosen on its own -- the plugin has already decided.
 * Measured on one fixture: plain `Bun.build` picks the browser entry where `Bun.resolveSync` picks the node one.
 *
 * Reported as `import { nanoid } from 'nanoid'` failing in a browser tab with
 * `ReferenceError: Can't find variable: Buffer`: nanoid@6.0.1's `exports["."]` is
 * `{ browser: "./index.browser.js", default: "./index.js" }`, and its `default` entry calls `Buffer.allocUnsafe`.
 * That `Buffer` is a **free global rather than an import**, so `nodePolyfills`'s builtin-blocking resolve hook
 * never sees it and the build succeeds -- the failure lands at run time in the page instead of at bundle time.
 *
 * Scope, deliberately: only the `exports` map is consulted. The top-level `browser` *field* is NOT honoured here,
 * because Bun does not honour it either -- measured on a `{"main":"./index.js","browser":"./index.browser.js"}`
 * package with **no plugin in the build at all**, where `Bun.build({target:"browser"})` still bundled the `main`
 * entry. Reading that field here would make JSLab diverge from Bun rather than match it. It is recorded as a
 * separate known gap instead.
 */
export function browserEntryFor(specifier: string, resolved: string): string | undefined {
  const { packageName, subpath } = splitSpecifier(specifier);
  const marker = `${sep}node_modules${sep}${packageName}${sep}`;
  // `lastIndexOf`, so a nested `node_modules` copy names its own package root rather than an outer one's.
  const index = resolved.lastIndexOf(marker);
  if (index < 0) return undefined;
  const packageRoot = resolved.slice(0, index + marker.length - 1);

  let manifest: { exports?: unknown };
  try {
    manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { exports?: unknown };
  } catch {
    return undefined; // unreadable or unparseable manifest: keep Bun's answer rather than guess
  }
  if (!manifest.exports || typeof manifest.exports !== "object") return undefined;

  const entry = exportsEntryFor(manifest.exports as Record<string, unknown>, subpath);
  if (!entry || !declaresBrowserCondition(entry.target)) return undefined;
  const selected = selectBrowserTarget(entry.target);
  if (selected === undefined || !selected.startsWith("./")) return undefined;

  const candidate = join(packageRoot, entry.star === null ? selected : selected.replaceAll("*", entry.star));
  // An export target must stay inside its own package, and must actually exist. Either failing means the manifest
  // is describing something this resolver does not understand, and Bun's original answer is the safer one.
  if (!candidate.startsWith(packageRoot + sep) || !existsSync(candidate)) return undefined;
  return candidate;
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
export function resolveBareSpecifier(specifier: string, ctx: ResolveContext): string | undefined {
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
      if (realpathSync(resolved).startsWith(nodeModulesPrefix)) return browserEntryFor(specifier, resolved) ?? resolved;
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
      build.onResolve({ filter: BARE_SPECIFIER }, (args) => {
        // A stub module imports nothing, so nothing should ever ask to resolve from inside one; ignore it if it does.
        if (args.namespace === VENDOR_STUB_NAMESPACE) return undefined;
        const resolved = resolveBareSpecifier(args.path, ctx);
        if (resolved) {
          resolvedImports.add(args.path);
          // Fix round 1 (C1): recorded for every resolution in every build -- direct or transitive, stubbed or not.
          if (resolvedFromWorkingDirectory(resolved, ctx.workingDirectory)) {
            options.workingDirectoryImports?.add(args.path);
          }
          if (!options.vendorStubs) return { path: resolved };
          // The app build never reads a line of package code: the specifier becomes a stub that reads whatever the
          // vendor chunk published for it (Task 8a). The specifier itself is the stub's identity, so two imports of
          // the same package share one stub, exactly as they shared one module before the split.
          return { path: args.path, namespace: VENDOR_STUB_NAMESPACE };
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
