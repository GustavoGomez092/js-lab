import type { RunEvent, RunState } from "@jslab/rpc-schema";

export type DisplayEvent = Exclude<RunEvent, { kind: "promiseSettled" } | { kind: "truncated" }>;

export interface OutputEntry {
  key: string;
  event: DisplayEvent;
}

export interface OutputState {
  runId: string | null;
  runState: RunState | null;
  activeHandles: number;
  entries: OutputEntry[];
  /** True while entries belong to a previous run (shown dimmed). */
  stale: boolean;
  truncated: number;
}

export const initialOutput: OutputState = {
  runId: null,
  runState: null,
  activeHandles: 0,
  entries: [],
  stale: false,
  truncated: 0,
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
    return { ...state, runId, runState, activeHandles: 0, truncated: 0, stale: state.entries.length > 0 };
  }
  const next = { ...state, runState, activeHandles: activeHandles ?? state.activeHandles };
  // A run that evaluates without producing output must still clear the previous run's entries.
  if (runState === "evaluating" && state.stale) return { ...next, entries: [], stale: false };
  return next;
}

const isTranspileError = (event: RunEvent) => event.kind === "error" && event.phase === "transpile";

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
  const next = [...entries];
  for (const event of events) {
    switch (event.kind) {
      case "truncated":
        truncated = event.dropped;
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
  return { ...state, entries: next, stale, truncated };
}

export function visibleEntries(state: OutputState, options: { showUndefined: boolean }): OutputEntry[] {
  if (options.showUndefined) return state.entries;
  return state.entries.filter((entry) => !(entry.event.kind === "result" && entry.event.value.t === "undefined"));
}
