import {
  type BootstrapPayload,
  bufferChangedSchema,
  type E2EResponse,
  type EncodedValue,
  e2eResponseSchema,
  runExpandParamsSchema,
  runStartParamsSchema,
  runTranspiledParamsSchema,
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
import { strings } from "./strings";

export { InvalidPayloadError };

export interface RpcHandlerDeps {
  coordinator: Pick<RunCoordinator, "start" | "stop" | "kill" | "wait" | "expand" | "mute" | "transpiled">;
  settings: Pick<SettingsStore, "current">;
  session: Pick<SessionStore, "session" | "readBuffers" | "readBuffer" | "setBuffer" | "patchTab">;
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

/**
 * F1: read each tab's buffer on its own, so one unreadable file doesn't fail the whole `app.bootstrap`.
 *
 * `SessionStore.readBuffers()` throws on the first tab whose buffer exists but can't be read (EACCES, EISDIR,
 * EIO). That rejection reached `main.tsx`'s catch, which showed a failure screen whose only control re-ran the
 * identical bootstrap -- an infinite loop the user could only escape by deleting files by hand. Reading per tab
 * keeps the app openable: the tabs that loaded are returned, and the ones that didn't are named in a notice.
 *
 * `readBuffer` has already put each skipped tab in the store's unreadable set, so `setBuffer` refuses to write
 * its buffer file. B1: that guard covers only the internal buffer file, NOT the tab's `filePath` -- so the ids
 * are reported to the UI (`unreadableBuffers`) and `file.save`/Save As refuse them as well. Without that, the UI
 * turned the omission into `""`, the tab read as dirty, and a plain ⌘S truncated the user's real file.
 * `readBuffers()` keeps its all-or-nothing contract for every other caller.
 */
async function readBuffersPerTab(
  session: RpcHandlerDeps["session"],
  log: RpcHandlerDeps["log"],
): Promise<{ buffers: Record<string, string>; unreadable: string[] }> {
  const buffers: Record<string, string> = {};
  const unreadable: string[] = [];
  for (const id of session.session.tabOrder) {
    try {
      buffers[id] = await session.readBuffer(id);
    } catch (error) {
      unreadable.push(id);
      log("Couldn't read a tab's buffer at startup", { tabId: id, error: String(error) });
    }
  }
  return { buffers, unreadable };
}

/** Handlers for the UI RPC. Every inbound payload is validated before use (spec §18). */
export function createRpcHandlers(deps: RpcHandlerDeps) {
  const { parse, message } = createValidators(deps.log);

  return {
    requests: {
      "app.bootstrap": async (): Promise<BootstrapPayload> => {
        const { buffers, unreadable } = await readBuffersPerTab(deps.session, deps.log);
        const notices = [...(deps.notices ?? [])];
        if (unreadable.length > 0) {
          notices.push({ id: "buffersUnreadable", message: strings.notices.buffersUnreadable(unreadable.length) });
        }
        return {
          settings: deps.settings.current,
          session: deps.session.session,
          buffers,
          // B1: the ids, not just the count in the notice -- the UI must be able to tell these tabs apart from
          // genuinely empty ones, or it invents `""` for them and offers to save that over their files.
          ...(unreadable.length > 0 ? { unreadableBuffers: unreadable } : {}),
          safeMode: deps.safeMode,
          versions: deps.versions,
          ...(deps.e2e ? { e2e: true } : {}),
          ...(deps.keybindings ? { keybindings: deps.keybindings.rules } : {}),
          ...(notices.length > 0 ? { notices } : {}),
        };
      },
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
      "run.transpiled": (input: unknown): Promise<{ code: string; source: string } | null> => {
        const { tabId, hideInstrumentation } = parse(runTranspiledParamsSchema, "run.transpiled", input);
        return deps.coordinator.transpiled(tabId, hideInstrumentation);
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
        // Captured before patchTab (fix round 1, F2): the tab's stored value as of right now, so a change is
        // detected against what's actually on record -- not merely against "was `muted` present in this
        // patch". The UI's sole producer of tab.patch (App.tsx's computeTabPatch) always sends the *entire*
        // layout object whenever anything tracked in it changed, so `patch.layout.muted` is present on nearly
        // every patch (a title rename, a runtime switch, a divider drag) even when mute itself didn't change;
        // gating on presence alone fired `coordinator.mute()` -- an extra webview round trip -- on every one.
        const previouslyMuted = deps.session.session.tabs[tabId]?.layout.muted;
        // The write happens after this returns (e.g. a buffer flush during a language rename), so a failure
        // must be caught here rather than left as an unhandled rejection (ruling I2).
        void deps.session
          .patchTab(tabId, patch)
          .catch((error) => deps.log("Handler for tab.patch failed", String(error)));
        // Task 15 (spec §5.12, EX-35): a mute toggle takes effect on whatever is running right now too, not just
        // the tab's next run -- `coordinator.mute` is a harmless no-op when nothing is running.
        if (patch.layout?.muted !== undefined && patch.layout.muted !== previouslyMuted) {
          deps.coordinator.mute(tabId, patch.layout.muted);
        }
      }),
      "ui.heartbeat": () => deps.onUiHeartbeat(),
      "e2e.response": message(e2eResponseSchema, "e2e.response", (response) => deps.onE2EResponse?.(response)),
    },
  };
}
