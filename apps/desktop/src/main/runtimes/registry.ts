import type { Runtime } from "@jslab/shared";
import type { RuntimeAdapter } from "./adapter";

export interface RuntimeRegistry {
  get(runtime: Runtime | undefined): RuntimeAdapter;
  /**
   * Every distinct registered adapter, de-duplicated by identity.
   *
   * For teardown that is not routed by a runtime: closing a tab has no run left to read a runtime from, and a tab
   * can switch runtime mid-session, so one tabId may hold resources in more than one adapter. `get(undefined)`
   * always resolves to Bun by design, which is why it cannot stand in here.
   */
  all(): RuntimeAdapter[];
}

/**
 * The runtime -> adapter lookup (spec §5.1). This function itself needs no change to support more runtimes --
 * `adapters` already accepts any `Partial<Record<Runtime, RuntimeAdapter>>` -- so "registering" a `WebAdapter`
 * (`./web-adapter.ts`, `createWebAdapter`) is a matter of the *caller* passing `browser`/`browser-node` keys, once
 * a real `WebviewSource` exists to construct one from. **A caller now does:** `main-services.ts` registers both
 * (`browser` and `browser-node`, via `createWebAdapter(webAdapterDeps(...))`) whenever a `webviewBridge` is
 * provided, which M4 landed along with the Main<->UI bridge a real `WebviewSource` needs. The earlier text here
 * said no caller did -- true when Task 7 deferred building one and Task 9 made the runtimes selectable without the
 * wiring, but stale since M4 closed that gap. `run-coordinator.ts` had the same stale claim and corrected it; this
 * copy was missed. The fallback below is therefore the *no-bridge* case (no `webviewBridge`, so no web adapter is
 * registered), not the normal one: a runtime with no adapter of its own falls back to Bun, same as
 * `effectiveRuntime` does for tab defaults -- except that fallback is no longer silent for an explicitly
 * requested runtime (see `get()` below):
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
    all() {
      // A Set because one adapter may legitimately be registered under several runtime ids; a teardown must reach
      // each adapter once, not once per key it answers to.
      return [
        ...new Set(Object.values(adapters).filter((adapter): adapter is RuntimeAdapter => adapter !== undefined)),
      ];
    },
  };
}
