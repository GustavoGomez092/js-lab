import type { Runtime } from "@jslab/shared";
import type { RuntimeAdapter } from "./adapter";

export interface RuntimeRegistry {
  get(runtime: Runtime | undefined): RuntimeAdapter;
}

/**
 * The runtime -> adapter lookup (spec §5.1). This function itself needs no change to support more runtimes --
 * `adapters` already accepts any `Partial<Record<Runtime, RuntimeAdapter>>` -- so "registering" a `WebAdapter`
 * (`./web-adapter.ts`, `createWebAdapter`) is a matter of the *caller* passing `browser`/`browser-node` keys, once
 * a real `WebviewSource` exists to construct one from. No caller does yet: `createWebAdapter` exists and is
 * unit-tested against a fake `WebviewSource`, but production has no real one to build it with -- Task 7 deferred
 * building it pending a live `<electrobun-webview>` DOM node, Task 8 landed that node but didn't wire the Main<->UI
 * bridge a real `WebviewSource` needs, and M4 Task 9 made `browser`/`browser-node` selectable in the UI without
 * that wiring existing (a known, disclosed gap -- see Task 9's report). Until a caller registers real adapters for
 * those keys, any runtime with no adapter of its own falls back to Bun, same as `effectiveRuntime` does for tab
 * defaults -- except that fallback is no longer silent for an explicitly requested runtime (see `get()` below):
 * unlike `effectiveRuntime`'s tab-default case, a user can now deliberately choose the runtime being discarded.
 */
export function createRuntimeRegistry(
  adapters: { bun: RuntimeAdapter } & Partial<Record<Runtime, RuntimeAdapter>>,
  log?: (message: string, detail?: unknown) => void,
): RuntimeRegistry {
  return {
    get(runtime) {
      // R-M4-T1-OPTIONAL-1: RunStartRequest.runtime is optional. undefined means no runtime was resolved for this
      // run at all, which always means Bun -- this is the one place that default is applied, so it never reaches
      // an adapter lookup as undefined, and is never logged below (nobody explicitly asked for anything).
      const id: Runtime = runtime ?? "bun";
      const adapter = adapters[id];
      // M4 Task 9 fix round 1: make the downgrade observable. Only when a runtime other than "bun" was explicitly
      // requested and has no adapter of its own -- an unresolved run (`id === "bun"` above) is never logged here.
      if (!adapter && id !== "bun") {
        log?.("Runtime has no registered adapter; falling back to Bun", { requestedRuntime: id });
      }
      return adapter ?? adapters.bun;
    },
  };
}
