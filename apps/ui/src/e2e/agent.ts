import type { E2EUiMethod } from "@jslab/rpc-schema";
import type { EditorHandle } from "../editor/editor-handle";
import type { AppStore } from "../state/store";
import { keyEventInit } from "./keys";
import { snapshotOutput, snapshotState } from "./snapshot";

export interface E2EAgentDeps {
  store: AppStore;
  /** Runs a command id; returns false when the id is unknown. */
  executeCommand(id: string, args?: unknown): boolean;
  editor(): EditorHandle | null;
  /** Where synthetic keys are dispatched; the app passes the focused element. */
  target(): EventTarget;
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
        if (!deps.executeCommand(id, args)) throw new Error(`Unknown command: ${id}`);
        return { executed: id };
      }
      case "state":
        return snapshotState(deps.store.getState());
      case "output":
        return { entries: snapshotOutput(deps.store.getState()) };
    }
  };
}
