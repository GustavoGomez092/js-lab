import type { RunState } from "@jslab/rpc-schema";
import type { Language } from "@jslab/shared";

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
