import type { DiagnosticPayload } from "@jslab/rpc-schema";
import { strings } from "../strings";

/** The filled dot in the glyph margin (spec §6.3). */
export const LOGPOINT_GLYPH = "logpoint-glyph";
/** The hollow dot: a logpoint on a line with nothing to log (spec §5.5). */
export const LOGPOINT_GLYPH_HOLLOW = "logpoint-glyph logpoint-glyph-hollow";

/** The transform's own "nothing to log here" warning (packages/transform/src/instrument.ts). */
const NO_VALUE_CODE = "logpoint-no-value";

export interface LogpointDecoration {
  line: number;
  hollow: boolean;
  glyphMarginClassName: string;
  hoverMessage: string;
}

/**
 * Which logpoint lines are hollow, per R-M5a-2: exactly the lines the latest run's transform reported as having
 * no loggable statement. The transform is the single source of truth — the UI never re-parses the code to guess.
 */
export function hollowLogpointLines(diagnostics: readonly DiagnosticPayload[]): ReadonlySet<number> {
  const lines = new Set<number>();
  for (const diagnostic of diagnostics) {
    if (diagnostic.code === NO_VALUE_CODE) lines.add(diagnostic.line);
  }
  return lines;
}

/** One decoration descriptor per logpoint line, in the order given. Framework-free, so it is unit-tested. */
export function logpointDecorations(lines: readonly number[], hollow: ReadonlySet<number>): LogpointDecoration[] {
  return lines.map((line) => {
    const isHollow = hollow.has(line);
    return {
      line,
      hollow: isHollow,
      glyphMarginClassName: isHollow ? LOGPOINT_GLYPH_HOLLOW : LOGPOINT_GLYPH,
      hoverMessage: isHollow ? strings.logpoints.noValue : strings.logpoints.tooltip,
    };
  });
}

/**
 * The line numbers a decorations collection currently holds, after Monaco's `stickiness` moved them through an
 * edit (spec §6.3, RunJS #731). Ascending and unique: two logpoints can be pushed onto the same line by a join.
 */
export function linesFromRanges(ranges: readonly { startLineNumber: number }[]): number[] {
  return [...new Set(ranges.map((range) => range.startLineNumber))].sort((a, b) => a - b);
}
