import type { E2EUiMethod } from "@jslab/rpc-schema";
import type { ExecuteResult } from "../commands/registry";
import type { EditorHandle } from "../editor/editor-handle";
import type { AppStore } from "../state/store";
import { keyEventInit } from "./keys";
import { snapshotOutput, snapshotState } from "./snapshot";

export interface E2EAgentDeps {
  store: AppStore;
  /** Runs a command id through the registry. */
  executeCommand(id: string, args?: unknown): ExecuteResult;
  editor(): Pick<EditorHandle, "typeText"> | null;
  /** Where synthetic keys are dispatched; the app passes the focused element. */
  target(): EventTarget;
  /** Monaco action ids from EDITOR_ACTIONS that don't exist in this Monaco build (verification step). */
  missingEditorActions?(): string[];
  editorOptions?(): Record<string, unknown> | null;
  /** Which layout regions are currently mounted, keyed by name (verification step, Task 16). */
  regions?(): Record<string, boolean>;
  /** Every command id registered in the UI command registry (Task 22 verification: every menu action is dispatchable). */
  registeredCommands?(): string[];
}

/** E2E-only command: clicks a temporary link inside the page, as a user clicking a web link would (R-M1-17(e)). */
export const E2E_OPEN_LINK = "e2e.openLink";

function openLink(args: unknown): { executed: string } {
  const href = (args as { href?: unknown } | undefined)?.href;
  if (typeof href !== "string" || !/^https?:\/\//.test(href)) throw new Error("e2e.openLink needs an http(s) URL");
  const link = document.createElement("a");
  link.href = href;
  link.dataset.e2eLink = "";
  document.body.append(link);
  try {
    link.click();
  } finally {
    link.remove();
  }
  return { executed: E2E_OPEN_LINK };
}

/**
 * Answers Main's `e2e.request` messages (spec §22.3). Main has already validated params with zod,
 * so the agent only narrows their types. Only installed for JSLAB_E2E=1 launches.
 */
export function createE2EAgent(deps: E2EAgentDeps) {
  return async (method: E2EUiMethod, params: unknown): Promise<unknown> => {
    switch (method) {
      case "type": {
        const { text, replace } = params as { text: string; replace?: boolean };
        const target = deps.target();
        const plainField =
          target instanceof HTMLInputElement ||
          (target instanceof HTMLTextAreaElement && !target.closest(".monaco-editor"));
        if (plainField) {
          const field = target as HTMLInputElement | HTMLTextAreaElement;
          const prototype =
            field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          // React tracks the value through the native setter; assigning `.value` directly would skip onChange.
          Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(field, replace ? text : field.value + text);
          field.dispatchEvent(new Event("input", { bubbles: true }));
          return { typed: text.length };
        }
        const editor = deps.editor();
        if (!editor) throw new Error("No editor is mounted");
        editor.typeText(text, replace === true);
        return { typed: text.length };
      }
      case "key": {
        const init = keyEventInit((params as { key: string }).key);
        const target = deps.target();
        const notPrevented = target.dispatchEvent(new KeyboardEvent("keydown", init));
        target.dispatchEvent(new KeyboardEvent("keyup", init));
        return { defaultPrevented: !notPrevented };
      }
      case "command": {
        const { id, args } = params as { id: string; args?: unknown };
        if (id === E2E_OPEN_LINK) return openLink(args);
        const result = deps.executeCommand(id, args);
        if (result === "unknown") throw new Error(`Unknown command: ${id}`);
        if (result === "disabled") throw new Error(`Command is disabled: ${id}`);
        return { executed: id };
      }
      case "state":
        return {
          ...snapshotState(deps.store.getState()),
          missingEditorActions: deps.missingEditorActions?.() ?? [],
          editorOptions: deps.editorOptions?.() ?? null,
          regions: deps.regions?.() ?? {},
          registeredCommands: deps.registeredCommands?.() ?? [],
        };
      case "output":
        return { entries: snapshotOutput(deps.store.getState(), (params as { tabId?: string }).tabId) };
    }
  };
}
