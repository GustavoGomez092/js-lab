import {
  type BootstrapPayload,
  bufferChangedSchema,
  type E2EResponse,
  type EncodedValue,
  e2eResponseSchema,
  runExpandParamsSchema,
  runStartParamsSchema,
  tabParamsSchema,
  tabPatchSchema,
} from "@jslab/rpc-schema";
import type { RunCoordinator } from "./runs/run-coordinator";
import type { SafeModeState } from "./services/safe-mode";
import type { SessionStore } from "./services/session-store";
import type { SettingsStore } from "./services/settings-store";

export interface RpcHandlerDeps {
  coordinator: Pick<RunCoordinator, "start" | "stop" | "kill" | "wait" | "expand">;
  settings: Pick<SettingsStore, "current">;
  session: Pick<SessionStore, "session" | "readBuffers" | "setBuffer" | "patchTab">;
  safeMode: SafeModeState;
  versions: { app: string; bun: string };
  log(message: string, detail?: unknown): void;
  onUiHeartbeat(): void;
  /** True for JSLAB_E2E=1 launches. */
  e2e?: boolean;
  onE2EResponse?(response: E2EResponse): void;
}

export class InvalidPayloadError extends Error {}

/** A valid request that Main declines to act on (for example an automatic run while Safe Mode is active). */
export class RunRefusedError extends Error {}

interface SafeParser<T> {
  safeParse(input: unknown): { success: true; data: T } | { success: false; error: { message: string } };
}

/** Handlers for the UI RPC. Every inbound payload is validated before use (spec §18). */
export function createRpcHandlers(deps: RpcHandlerDeps) {
  const parse = <T>(schema: SafeParser<T>, method: string, input: unknown): T => {
    const result = schema.safeParse(input);
    if (!result.success) {
      deps.log(`Rejected invalid ${method} payload`, result.error.message);
      throw new InvalidPayloadError(`Invalid payload for ${method}`);
    }
    return result.data;
  };

  // Messages are fire-and-forget: an invalid one is logged and dropped, never thrown into the RPC layer.
  const message =
    <T>(schema: SafeParser<T>, method: string, handle: (payload: T) => void) =>
    (input: unknown) => {
      try {
        handle(parse(schema, method, input));
      } catch (error) {
        if (!(error instanceof InvalidPayloadError)) deps.log(`Handler for ${method} failed`, String(error));
      }
    };

  return {
    requests: {
      "app.bootstrap": async (): Promise<BootstrapPayload> => ({
        settings: deps.settings.current,
        session: deps.session.session,
        buffers: await deps.session.readBuffers(),
        safeMode: deps.safeMode,
        versions: deps.versions,
        ...(deps.e2e ? { e2e: true } : {}),
      }),
      "run.start": (input: unknown): { runId: string } => {
        const { tabId, code, language, logpoints, reason } = parse(runStartParamsSchema, "run.start", input);
        // Defence in depth (spec §5.14): Main never starts an automatic run in Safe Mode, whatever the UI sends.
        // Manual runs stay allowed.
        if (reason === "auto" && deps.safeMode.active) {
          deps.log("Refused an automatic run while Safe Mode is active", { tabId });
          throw new RunRefusedError("Automatic runs are disabled in Safe Mode");
        }
        return deps.coordinator.start({ tabId, code, language, logpoints });
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
      }),
      "ui.heartbeat": () => deps.onUiHeartbeat(),
      "e2e.response": message(e2eResponseSchema, "e2e.response", (response) => deps.onE2EResponse?.(response)),
    },
  };
}
