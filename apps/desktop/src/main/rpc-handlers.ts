import {
  type BootstrapPayload,
  bufferChangedSchema,
  type EncodedValue,
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
}

export class InvalidPayloadError extends Error {}

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
      }),
      "run.start": (input: unknown): { runId: string } => {
        const { tabId, code, language, logpoints } = parse(runStartParamsSchema, "run.start", input);
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
        void deps.session.patchTab(tabId, patch);
      }),
      "ui.heartbeat": () => deps.onUiHeartbeat(),
    },
  };
}
