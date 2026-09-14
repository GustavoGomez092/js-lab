import type { EditorHandle } from "../editor/editor-handle";
import type { AppStore } from "../state/store";
import { strings } from "../strings";
import type { Formatter } from "./formatter";
import { computeEdits } from "./line-diff";
import { prettierOptions } from "./prettier-options";

export function createFormatActions(deps: { store: AppStore; formatter: Formatter; editor(): EditorHandle | null }) {
  return {
    /** Formats a tab; the active tab through Monaco with minimal edits, others through their buffer. */
    async formatTab(tabId?: string): Promise<boolean> {
      const state = deps.store.getState();
      const id = tabId ?? state.activeTabId;
      const tab = id ? state.tabs[id] : undefined;
      if (!id || !tab || !state.settings) return false;
      const editor = id === state.activeTabId ? deps.editor() : null;
      const code = editor ? editor.getValue() : (state.buffers[id] ?? "");
      const outcome = await deps.formatter.format(
        code,
        prettierOptions(state.settings, tab.language),
        editor?.getCursorOffset() ?? 0,
      );
      if (!outcome.ok) {
        deps.store.getState().setStatusMessage(strings.format.failed(outcome.error.split("\n")[0] ?? outcome.error));
        return false;
      }
      if (outcome.formatted === code) return true;
      const latest = editor ? editor.getValue() : (deps.store.getState().buffers[id] ?? "");
      if (latest !== code) return false;
      if (editor) editor.applyOffsetEdits(computeEdits(code, outcome.formatted), outcome.cursorOffset);
      else deps.store.getState().editCode(outcome.formatted, id);
      return true;
    },
  };
}
