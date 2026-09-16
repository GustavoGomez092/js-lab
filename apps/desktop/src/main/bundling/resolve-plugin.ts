import { realpathSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import type { BunPlugin } from "bun";

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
 * shared packages `node_modules`. Returns undefined when neither has it, so the caller can fall through to Bun's
 * own resolver -- which reports the failure as a `ResolveMessage` carrying the specifier and its source position,
 * exactly what an unresolved-import `BundleError` needs (no need to reconstruct that ourselves).
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
 */
export function jslabResolve(ctx: ResolveContext, resolvedImports: Set<string>): BunPlugin {
  return {
    name: "jslab-resolve",
    setup(build) {
      build.onResolve({ filter: BARE_SPECIFIER }, (args) => {
        const resolved = resolveBareSpecifier(args.path, ctx);
        if (!resolved) return undefined;
        resolvedImports.add(args.path);
        return { path: resolved };
      });
    },
  };
}
