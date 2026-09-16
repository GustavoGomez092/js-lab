import type { Runtime } from "@jslab/shared";
import type { RuntimeAdapter } from "./adapter";

export interface RuntimeRegistry {
  get(runtime: Runtime | undefined): RuntimeAdapter;
}

/**
 * The runtime -> adapter lookup (spec §5.1). This function itself needs no change to support more runtimes --
 * `adapters` already accepts any `Partial<Record<Runtime, RuntimeAdapter>>` -- so "registering" a `WebAdapter`
 * (Task 7, `./web-adapter.ts`) is a matter of the *caller* passing `browser`/`browser-node` keys, once a real
 * `WebviewSource` exists to construct one from (Task 7's own report explains why that production wiring waits on
 * Task 8's `<electrobun-webview>` DOM node). Until a caller does, any runtime with no adapter of its own falls back
 * to Bun, same as `effectiveRuntime` does for tab defaults.
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
