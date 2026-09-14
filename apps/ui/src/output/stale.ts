import type { DisplayEvent, OutputState } from "../state/output";
import { strings } from "../strings";

const isTranspileError = (event: DisplayEvent) => event.kind === "error" && event.phase === "transpile";

/** Spec §5.11: after a failed compile the previous run's output stays, dimmed, labeled "Last successful run". */
export function lastSuccessfulRunLabel(output: OutputState): string | null {
  const kept = output.entries.some((entry) => !isTranspileError(entry.event));
  return output.stale && output.runState === "failed" && kept ? strings.output.lastSuccessfulRun : null;
}

/** Only the previous run's entries are dimmed; a new syntax error belongs to the code in the editor (final review M8). */
export function entryIsStale(output: OutputState, event: DisplayEvent): boolean {
  return output.stale && !isTranspileError(event);
}
