import type { Runtime } from "@jslab/shared";
import type { RuntimeAdapter } from "./adapter";

export interface RuntimeRegistry {
  get(runtime: Runtime | undefined): RuntimeAdapter;
}

/**
 * The runtime -> adapter lookup (spec §5.1). Only `bun` has a real implementation in M4 Task 2; Task 7 registers a
 * `WebAdapter` for `browser`/`browser-node` here (as additional keys of `adapters`) -- until then, any runtime with
 * no adapter of its own falls back to Bun, same as `effectiveRuntime` does for tab defaults.
 */
export function createRuntimeRegistry(
  adapters: { bun: RuntimeAdapter } & Partial<Record<Runtime, RuntimeAdapter>>,
): RuntimeRegistry {
  return {
    get(runtime) {
      // R-M4-T1-OPTIONAL-1: RunStartRequest.runtime is optional. undefined means no runtime was resolved for this
      // run at all, which always means Bun -- this is the one place that default is applied, so it never reaches
      // an adapter lookup as undefined.
      const id: Runtime = runtime ?? "bun";
      return adapters[id] ?? adapters.bun;
    },
  };
}
