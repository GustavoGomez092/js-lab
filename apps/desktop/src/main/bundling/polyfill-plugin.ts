import { readFileSync } from "node:fs";
import type { Runtime } from "@jslab/shared";
import type { BunPlugin } from "bun";
import type { BundleError } from "./bundler";
import { buildCodeFrame, locateImport } from "./locate-import";
import { isNodeBuiltin } from "./node-builtins";

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
 * - `browser-node` is a clean seam for Task 10, which fills this table in with the real bundled polyfills and the
 *   async Node bridge (spec §5.13). Until then it registers nothing, so a builtin import there falls through to
 *   Bun's default (harmless placeholder) stub -- not implementing §5.13 here, per the brief.
 *
 * `jslabResolve` (the plugin registered before this one) already defers a bare specifier it recognizes as a Node
 * builtin -- returning `undefined` instead of failing it -- specifically so this plugin still gets to produce its
 * own, more specific error for it (fix round 1, C1).
 */
export function nodePolyfills(runtime: Runtime, onError: (error: BundleError) => void): BunPlugin {
  return {
    name: "jslab-node-polyfills",
    setup(build) {
      if (runtime !== "browser") return;
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
    },
  };
}
