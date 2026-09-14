import type { RunState } from "@jslab/rpc-schema";
import type { Language, Runtime } from "@jslab/shared";

export const LANGUAGE_LABELS: Record<Language, string> = {
  typescript: "TypeScript",
  javascript: "JavaScript",
  tsx: "TSX",
  jsx: "JSX",
};

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
}): string {
  if (input.state === null) {
    if (input.safeMode) return "Safe Mode: press ⌘R to run";
    return input.autoRunArmed ? "" : "Paused: press ⌘R to run";
  }
  switch (input.state) {
    case "transpiling":
    case "evaluating":
      return "Running…";
    case "settled":
      return `Running: ${input.activeHandles} active ${input.activeHandles === 1 ? "handle" : "handles"}`;
    case "stopping":
      return "Stopping…";
    case "stopped":
      return "Stopped";
    case "killed":
      return "Run killed";
    case "failed":
      return "Failed";
    case "unresponsive":
      return "Not responding";
    case "idle":
      return "";
  }
}

export const RUNTIME_LABELS: Record<Runtime, string> = {
  "browser-node": "Browser & Node APIs",
  bun: "Bun",
  browser: "Browser",
};

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
