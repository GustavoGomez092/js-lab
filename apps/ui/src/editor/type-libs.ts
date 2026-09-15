import type { TypeFile } from "@jslab/rpc-schema";
import type { RuntimePack } from "./ts-environment";

/** Loads a bundled runtime type pack (a lazily loaded Vite chunk, spec §6.2). Only Editor.tsx imports this module. */
export async function loadRuntimePack(pack: RuntimePack): Promise<readonly TypeFile[]> {
  const module =
    pack === "bun" ? await import("virtual:jslab-type-libs/bun") : await import("virtual:jslab-type-libs/node");
  return module.default;
}
