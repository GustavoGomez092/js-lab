import { builtinModules } from "node:module";

/** Every Node builtin Bun knows about, minus the private `_stream_*`/`_http_*` internals nothing ever imports directly. */
const NODE_BUILTINS = new Set(builtinModules.filter((name) => !name.startsWith("_")));

/**
 * `"node:path"` -> `"path"`; a specifier with no `node:` prefix is returned as-is. Shared by `isNodeBuiltin` below
 * and, since fix round 1 (I2), by `polyfill-plugin.ts`'s `browser-node` module table: without normalizing through
 * this same function, a `node:`-prefixed import bypasses the §5.13 table entirely (measured: `node:path`/
 * `node:buffer` silently fall through to Bun's own browser shims instead of the vendored polyfills, and
 * `node:process` hard-errors) even though `isNodeBuiltin` already defers it here correctly.
 */
export function stripNodePrefix(specifier: string): string {
  return specifier.startsWith("node:") ? specifier.slice("node:".length) : specifier;
}

export function isNodeBuiltin(specifier: string): boolean {
  return NODE_BUILTINS.has(stripNodePrefix(specifier));
}
