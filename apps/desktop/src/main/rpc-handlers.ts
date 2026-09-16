import {
  type BootstrapPayload,
  bufferChangedSchema,
  type E2EResponse,
  type EncodedValue,
  e2eResponseSchema,
  runExpandParamsSchema,
  runStartParamsSchema,
  type StartupNotice,
  tabParamsSchema,
  tabPatchSchema,
} from "@jslab/rpc-schema";
import { effectiveRuntime, type KeybindingRule, scriptFileName } from "@jslab/shared";
import { createValidators, InvalidPayloadError } from "./rpc/validate";
import type { RunCoordinator } from "./runs/run-coordinator";
import type { SafeModeState } from "./services/safe-mode";
import type { SessionStore } from "./services/session-store";
import type { SettingsStore } from "./services/settings-store";

export { InvalidPayloadError };

export interface RpcHandlerDeps {
  coordinator: Pick<RunCoordinator, "start" | "stop" | "kill" | "wait" | "expand" | "mute">;
  settings: Pick<SettingsStore, "current">;
  session: Pick<SessionStore, "session" | "readBuffers" | "setBuffer" | "patchTab">;
  safeMode: SafeModeState;
  versions: { app: string; bun: string };
  log(message: string, detail?: unknown): void;
  onUiHeartbeat(): void;
  /** True for JSLAB_E2E=1 launches. */
  e2e?: boolean;
  onE2EResponse?(response: E2EResponse): void;
  keybindings?: { rules: KeybindingRule[] };
  notices?: StartupNotice[];
}

/** A valid request that Main declines to act on (for example an automatic run while Safe Mode is active). */
export class RunRefusedError extends Error {}

/** Handlers for the UI RPC. Every inbound payload is validated before use (spec §18). */
export function createRpcHandlers(deps: RpcHandlerDeps) {
  const { parse, message } = createValidators(deps.log);

  return {
    requests: {
      "app.bootstrap": async (): Promise<BootstrapPayload> => ({
        settings: deps.settings.current,
        session: deps.session.session,
        buffers: await deps.session.readBuffers(),
        safeMode: deps.safeMode,
        versions: deps.versions,
        ...(deps.e2e ? { e2e: true } : {}),
        ...(deps.keybindings ? { keybindings: deps.keybindings.rules } : {}),
        ...(deps.notices && deps.notices.length > 0 ? { notices: deps.notices } : {}),
      }),
      "run.start": (input: unknown): { runId: string } => {
        const { tabId, code, language, logpoints, reason, runtime } = parse(runStartParamsSchema, "run.start", input);
        // Defence in depth (spec §5.14): Main never starts an automatic run in Safe Mode, whatever the UI sends.
        // Manual runs stay allowed.
        if (reason === "auto" && deps.safeMode.active) {
          deps.log("Refused an automatic run while Safe Mode is active", { tabId });
          throw new RunRefusedError("Automatic runs are disabled in Safe Mode");
        }
        const tab = deps.session.session.tabs[tabId];
        return deps.coordinator.start({
          tabId,
          code,
          language,
          logpoints,
          // The tab is the source of truth; the UI's copy can lag (M4 T1). Every runtime is available since M4
          // Task 9 (AVAILABLE_RUNTIMES), so a tab whose runtime differs from the request's now actually starts on
          // its own runtime (R-M4-T1-MINOR-1), not just Bun.
          runtime: effectiveRuntime(tab?.runtime ?? runtime),
          workingDirectory: tab?.workingDirectory ?? null,
          // The run compiles as the request's language, so __filename's extension follows it (N-4).
          scriptName: tab ? scriptFileName({ ...tab, language }, code) : "Untitled.ts",
          // Task 15 (spec §5.12, EX-35): the tab's saved mute preference, applied the instant a web run starts.
          muted: tab?.layout.muted ?? false,
        });
      },
      "run.expand": (input: unknown): Promise<EncodedValue | null> => {
        const { tabId, runId, handleId } = parse(runExpandParamsSchema, "run.expand", input);
        return deps.coordinator.expand(tabId, runId, handleId);
      },
    },
    messages: {
      "run.stop": message(tabParamsSchema, "run.stop", ({ tabId }) => deps.coordinator.stop(tabId)),
      "run.kill": message(tabParamsSchema, "run.kill", ({ tabId }) => deps.coordinator.kill(tabId)),
      "run.wait": message(tabParamsSchema, "run.wait", ({ tabId }) => deps.coordinator.wait(tabId)),
      "buffer.changed": message(bufferChangedSchema, "buffer.changed", ({ tabId, content }) =>
        deps.session.setBuffer(tabId, content),
      ),
      "tab.patch": message(tabPatchSchema, "tab.patch", ({ tabId, patch }) => {
        // The write happens after this returns (e.g. a buffer flush during a language rename), so a failure
        // must be caught here rather than left as an unhandled rejection (ruling I2).
        void deps.session
          .patchTab(tabId, patch)
          .catch((error) => deps.log("Handler for tab.patch failed", String(error)));
        // Task 15 (spec §5.12, EX-35): a mute toggle takes effect on whatever is running right now too, not just
        // the tab's next run -- `coordinator.mute` is a harmless no-op when nothing is running.
        if (patch.layout?.muted !== undefined) deps.coordinator.mute(tabId, patch.layout.muted);
      }),
      "ui.heartbeat": () => deps.onUiHeartbeat(),
      "e2e.response": message(e2eResponseSchema, "e2e.response", (response) => deps.onE2EResponse?.(response)),
    },
  };
}
