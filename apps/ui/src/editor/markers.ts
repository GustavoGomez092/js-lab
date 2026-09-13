import type { DiagnosticPayload } from "@jslab/rpc-schema";
import type { OutputState } from "../state/output";

export interface EditorMarker {
  severity: "error" | "warning";
  message: string;
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
  source: "jslab" | "syntax" | "runtime";
}

const END_OF_LINE = 10_000;

/**
 * Editor squiggles for the current run: transform warnings (magic comments, logpoints), syntax errors and runtime
 * errors mapped to their source line (spec §5.11). Errors from a stale previous run are not marked, except syntax
 * errors, which always belong to the code currently in the editor.
 */
export function markersFor(diagnostics: DiagnosticPayload[], output: OutputState): EditorMarker[] {
  const markers: EditorMarker[] = diagnostics
    .filter((d) => d.code !== "syntax")
    .map((d) => ({
      severity: d.severity,
      message: d.message,
      startLineNumber: d.line,
      startColumn: d.column,
      endLineNumber: d.line,
      endColumn: END_OF_LINE,
      source: "jslab",
    }));
  for (const { event } of output.entries) {
    if (event.kind !== "error" || event.line == null) continue;
    const syntax = event.phase === "transpile";
    if (output.stale && !syntax) continue;
    markers.push({
      severity: "error",
      message: `${event.name}: ${event.message}`,
      startLineNumber: event.line,
      startColumn: event.column ?? 1,
      endLineNumber: event.line,
      endColumn: END_OF_LINE,
      source: syntax ? "syntax" : "runtime",
    });
  }
  return markers;
}
