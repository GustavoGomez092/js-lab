import type { RunState } from "@jslab/rpc-schema";
import type { Language, Runtime } from "@jslab/shared";
import { strings } from "../strings";

export const LANGUAGE_LABELS: Record<Language, string> = strings.settings.options.language;

export const BUSY_STATES: ReadonlySet<RunState> = new Set([
  "transpiling",
  "evaluating",
  "settled",
  "stopping",
  "unresponsive",
]);

export function runStateLabel(input: {
  state: RunState | null;
  activeHandles: number;
  autoRunArmed: boolean;
  safeMode: boolean;
  /** The formatted Run chord, or null when that binding was removed. */
  keys: string | null;
}): string {
  const labels = strings.shell.runState;
  if (input.state === null) {
    if (input.safeMode) return labels.safeModePaused(input.keys);
    return input.autoRunArmed ? "" : labels.paused(input.keys);
  }
  switch (input.state) {
    case "transpiling":
    case "evaluating":
      return labels.running;
    case "settled":
      return labels.settled(input.activeHandles);
    case "stopping":
      return labels.stopping;
    case "stopped":
      return labels.stopped;
    case "killed":
      return labels.killed;
    case "failed":
      return labels.failed;
    case "unresponsive":
      return labels.unresponsive;
    case "idle":
      return "";
  }
}

export const RUNTIME_LABELS: Record<Runtime, string> = strings.settings.options.runtime;

export type RunStateKind = "idle" | "running" | "settled" | "failed" | "warn";

export function runStateKind(state: RunState | null): RunStateKind {
  switch (state) {
    case "transpiling":
    case "evaluating":
    case "stopping":
      return "running";
    case "settled":
      return "settled";
    case "failed":
      return "failed";
    case "unresponsive":
      return "warn";
    default:
      return "idle";
  }
}
