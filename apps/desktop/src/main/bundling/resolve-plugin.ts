import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import type { BunPlugin } from "bun";
import type { BundleError } from "./bundler";
import { buildCodeFrame, locateImport } from "./locate-import";
import { isNodeBuiltin } from "./node-builtins";

/** Bare (npm-style) specifiers only: not relative (`./`, `../`), not absolute (`/`). */
const BARE_SPECIFIER = /^[^./]/;

export interface ResolveContext {
  /** The tab's working directory, or null when none is set (spec §5.3). */
  workingDirectory: string | null;
  /** `apps/desktop/src/main/app-paths.ts:46`'s `packagesNodeModules` -- the shared packages `node_modules` itself. */
  packagesNodeModules: string;
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
      if (realpathSync(resolved).startsWith(nodeModulesPrefix)) return resolved;
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
 * one. That's safe from the same ancestor-walk leak regardless, since `nodePolyfills` blocks a builtin by name, not
 * by attempting filesystem resolution at all.
 */
export function jslabResolve(
  ctx: ResolveContext,
  resolvedImports: Set<string>,
  onError: (error: BundleError) => void,
): BunPlugin {
  return {
    name: "jslab-resolve",
    setup(build) {
      build.onResolve({ filter: BARE_SPECIFIER }, (args) => {
        const resolved = resolveBareSpecifier(args.path, ctx);
        if (resolved) {
          resolvedImports.add(args.path);
          return { path: resolved };
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
