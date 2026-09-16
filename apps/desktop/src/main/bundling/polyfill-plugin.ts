import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import type { Runtime } from "@jslab/shared";
import type { BunPlugin } from "bun";
import type { BundleError } from "./bundler";

/** Every Node builtin Bun knows about, minus the private `_stream_*`/`_http_*` internals nothing ever imports directly. */
const NODE_BUILTINS = new Set(builtinModules.filter((name) => !name.startsWith("_")));

function isNodeBuiltin(specifier: string): boolean {
  const bare = specifier.startsWith("node:") ? specifier.slice("node:".length) : specifier;
  return NODE_BUILTINS.has(bare);
}

interface ImportLocation {
  line: number;
  column: number;
  lineText: string;
}

/**
 * Finds the quoted specifier text in the importing file's source, the same way a `ResolveMessage`'s `position`
 * would if Bun's own resolver had failed the way it does for a missing npm package (§5.11's code frame). Line is
 * 1-indexed; column is 1-indexed and points at the specifier's first character (matching `Diagnostic.column` in
 * `packages/transform/src/types.ts`, which the rest of the app's error presentation already expects).
 */
function locateImport(source: string, specifier: string): ImportLocation | undefined {
  for (const quote of ['"', "'"]) {
    const needle = `${quote}${specifier}${quote}`;
    const index = source.indexOf(needle);
    if (index === -1) continue;
    const specifierStart = index + 1;
    const before = source.slice(0, specifierStart);
    const lastNewline = before.lastIndexOf("\n");
    return {
      line: before.split("\n").length,
      column: specifierStart - lastNewline,
      lineText: source.split("\n")[before.split("\n").length - 1] ?? "",
    };
  }
  return undefined;
}

function buildCodeFrame(lineText: string, column: number): string {
  return `${lineText}\n${" ".repeat(Math.max(column - 1, 0))}^`;
}

/**
 * `nodePolyfills` (spec §5.12): the second of `Bun.build`'s three plugins, the §5.13 Node-builtin table.
 *
 * - `browser` has no Node builtins at all (confirmed by measurement: left unhandled, `Bun.build({target:'browser'})`
 *   silently stubs an unresolved builtin to `{}` rather than failing the build -- which would hide a real problem
 *   from the user at bundle time only to surface it as a confusing runtime error later). So every builtin bare
 *   specifier is explicitly caught here and turned into an install-assist-shaped `BundleError` (`specifier` set;
 *   §11.4's own "node: and built-ins are ignored" rule keeps install-assist from offering to install it) reported
 *   through `onError` before the plugin forces the build to fail. The position/code-frame is recovered by a direct
 *   text search of the importing file, since forcing a Bun.build failure from a plugin callback (throwing, or
 *   resolving to a path that can't load) discards whatever `position`/`specifier` Bun would otherwise have
 *   attached to the resulting `BuildMessage` (measured: both come back empty).
 * - `browser-node` is a clean seam for Task 10, which fills this table in with the real bundled polyfills and the
 *   async Node bridge (spec §5.13). Until then it registers nothing, so a builtin import there falls through to
 *   Bun's default (harmless placeholder) stub -- not implementing §5.13 here, per the brief.
 */
export function nodePolyfills(runtime: Runtime, onError: (error: BundleError) => void): BunPlugin {
  return {
    name: "jslab-node-polyfills",
    setup(build) {
      if (runtime !== "browser") return;
      build.onResolve({ filter: /^[^./]/ }, (args) => {
        if (!isNodeBuiltin(args.path)) return undefined;
        let location: ImportLocation | undefined;
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
