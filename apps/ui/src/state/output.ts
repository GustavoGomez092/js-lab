import type { RunEvent, RunState } from "@jslab/rpc-schema";

export type DisplayEvent = Exclude<RunEvent, { kind: "promiseSettled" } | { kind: "truncated" } | { kind: "dialog" }>;

export interface OutputEntry {
  key: string;
  event: DisplayEvent;
}

/** Task 13 (spec §5.12): one `alert()` call from a web-runtime tab's page, queued for `WebDialog` to show as
 *  JSLab's own non-blocking dialog -- routed here rather than into `entries` for the same reason `promiseSettled`/
 *  `truncated` are excluded from `DisplayEvent`: it isn't a console-output row. */
export interface WebDialogEntry {
  key: string;
  text: string;
}

export interface OutputState {
  runId: string | null;
  runState: RunState | null;
  activeHandles: number;
  entries: OutputEntry[];
  /** True while entries belong to a previous run (shown dimmed). */
  stale: boolean;
  truncated: number;
  /** FIFO: every `alert()` call gets shown, none silently dropped for arriving while another is still up. */
  dialogs: WebDialogEntry[];
}

export const initialOutput: OutputState = {
  runId: null,
  runState: null,
  activeHandles: 0,
  entries: [],
  stale: false,
  truncated: 0,
  dialogs: [],
};

export function applyRunState(
  state: OutputState,
  runId: string,
  runState: RunState,
  activeHandles?: number,
): OutputState {
  if (runId !== state.runId) {
    // Every run announces "transpiling" first; later states for unknown runs are stale messages.
    if (runState !== "transpiling") return state;
    // Task 13: a fresh run gets a clean dialog queue too -- an alert from a run that's no longer the shown one
    // has nothing left to answer for.
    return { ...state, runId, runState, activeHandles: 0, truncated: 0, dialogs: [], stale: state.entries.length > 0 };
  }
  const next = { ...state, runState, activeHandles: activeHandles ?? state.activeHandles };
  // A run that evaluates without producing output must still clear the previous run's entries.
  if (runState === "evaluating" && state.stale) return { ...next, entries: [], stale: false };
  return next;
}

export const isTranspileError = (event: RunEvent) => event.kind === "error" && event.phase === "transpile";

export function applyRunEvents(state: OutputState, runId: string, events: RunEvent[]): OutputState {
  if (runId !== state.runId || events.length === 0) return state;

  let entries = state.entries;
  let stale = state.stale;
  if (stale) {
    if (events.every(isTranspileError)) {
      // Keep the last successful output visible (dimmed) above the new syntax error.
      entries = entries.filter((entry) => !isTranspileError(entry.event));
    } else {
      entries = [];
      stale = false;
    }
  }

  let truncated = state.truncated;
  let dialogs = state.dialogs;
  const next = [...entries];
  for (const event of events) {
    switch (event.kind) {
      case "truncated":
        truncated = event.dropped;
        break;
      case "dialog":
        dialogs = [...dialogs, { key: `${runId}:${event.seq}`, text: event.text }];
        break;
      case "promiseSettled": {
        const index = next.findIndex((entry) => entry.event.seq === event.ref && entry.event.kind === "result");
        const target = next[index];
        if (target && target.event.kind === "result")
          next[index] = { ...target, event: { ...target.event, value: event.value } };
        break;
      }
      case "console":
        if (event.level === "clear") {
          next.length = 0;
          break;
        }
        next.push({ key: `${runId}:${event.seq}`, event });
        break;
      default:
        next.push({ key: `${runId}:${event.seq}`, event });
    }
  }
  return { ...state, entries: next, stale, truncated, dialogs };
}

export function visibleEntries(state: OutputState, options: { showUndefined: boolean }): OutputEntry[] {
  if (options.showUndefined) return state.entries;
  return state.entries.filter((entry) => !(entry.event.kind === "result" && entry.event.value.t === "undefined"));
}

/** Task 13: removes one shown-and-answered dialog from the queue. A no-op for a key that's already gone (closing
 *  the same dialog twice, or one a run transition already cleared). */
export function dismissWebDialog(state: OutputState, key: string): OutputState {
  if (!state.dialogs.some((dialog) => dialog.key === key)) return state;
  return { ...state, dialogs: state.dialogs.filter((dialog) => dialog.key !== key) };
}
