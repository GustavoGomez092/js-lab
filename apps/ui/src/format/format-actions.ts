import type { EditorHandle } from "../editor/editor-handle";
import type { TimerApi } from "../state/auto-run";
import type { AppStore } from "../state/store";
import { strings } from "../strings";
import type { Formatter } from "./formatter";
import { computeEdits } from "./line-diff";
import { prettierOptions } from "./prettier-options";

/** A format pending longer than this shows "Formatting…" in the status bar (review rec 1). */
export const FORMAT_BUSY_DELAY_MS = 300;

const defaultTimers: TimerApi = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createFormatActions(deps: {
  store: AppStore;
  formatter: Formatter;
  editor(): EditorHandle | null;
  timers?: TimerApi;
}) {
  const timers = deps.timers ?? defaultTimers;

  /** Shows "Formatting…" once a request has been pending for FORMAT_BUSY_DELAY_MS; the returned function ends it. */
  const busyWhile = () => {
    let shown = false;
    const timer = timers.setTimeout(() => {
      shown = true;
      deps.store.getState().setStatusMessage(strings.format.busy, { sticky: true });
    }, FORMAT_BUSY_DELAY_MS);
    return () => {
      timers.clearTimeout(timer);
      if (shown && deps.store.getState().statusMessage === strings.format.busy) {
        deps.store.getState().setStatusMessage(null);
      }
    };
  };

  return {
    /** Formats a tab; the active tab through Monaco with minimal edits, others through their buffer. */
    async formatTab(tabId?: string): Promise<boolean> {
      const state = deps.store.getState();
      const id = tabId ?? state.activeTabId;
      const tab = id ? state.tabs[id] : undefined;
      if (!id || !tab || !state.settings) return false;
      const editor = id === state.activeTabId ? deps.editor() : null;
      const code = editor ? editor.getValue() : (state.buffers[id] ?? "");
      const done = busyWhile();
      let outcome: Awaited<ReturnType<Formatter["format"]>>;
      try {
        outcome = await deps.formatter.format(
          code,
          prettierOptions(state.settings, tab.language),
          editor?.getCursorOffset() ?? 0,
        );
      } finally {
        done();
      }
      // Fix round 1 (I-2): `editor` is the single global Monaco editor, captured before the await above. If
      // the active tab changed while Prettier ran, that handle now belongs to a different tab's model, so
      // never read or write through it.
      if (editor && deps.store.getState().activeTabId !== id) return false;
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
