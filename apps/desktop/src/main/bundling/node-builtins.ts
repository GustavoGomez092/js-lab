import { builtinModules } from "node:module";

/** Every Node builtin Bun knows about, minus the private `_stream_*`/`_http_*` internals nothing ever imports directly. */
const NODE_BUILTINS = new Set(builtinModules.filter((name) => !name.startsWith("_")));

export function isNodeBuiltin(specifier: string): boolean {
  const bare = specifier.startsWith("node:") ? specifier.slice("node:".length) : specifier;
  return NODE_BUILTINS.has(bare);
}
