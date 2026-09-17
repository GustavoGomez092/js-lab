import { describe, expect, test } from "bun:test";
import type { DiagnosticPayload } from "@jslab/rpc-schema";
import {
  hollowLogpointLines,
  LOGPOINT_GLYPH,
  LOGPOINT_GLYPH_HOLLOW,
  linesFromRanges,
  logpointDecorations,
} from "../src/editor/logpoints";
import { strings } from "../src/strings";

const diagnostic = (overrides: Partial<DiagnosticPayload>): DiagnosticPayload => ({
  severity: "warning",
  code: "logpoint-no-value",
  message: "Logpoint has no value to log on this line",
  line: 1,
  column: 1,
  ...overrides,
});

describe("logpoint model (spec §5.5, §6.3)", () => {
  test("a line the transform reported as having no value to log is hollow", () => {
    const hollow = hollowLogpointLines([
      diagnostic({ line: 2 }),
      diagnostic({ line: 7 }),
      // Any other diagnostic on a line leaves it filled: only logpoint-no-value means "nothing to log here".
      diagnostic({ code: "magic-comment-no-value", line: 4 }),
      diagnostic({ code: "syntax", severity: "error", line: 5 }),
    ]);
    expect([...hollow].sort((a, b) => a - b)).toEqual([2, 7]);
    expect(hollowLogpointLines([])).toEqual(new Set());
  });

  test("decorations are filled by default and hollow with a tooltip where there is nothing to log", () => {
    expect(logpointDecorations([1, 2], new Set([2]))).toEqual([
      { line: 1, hollow: false, glyphMarginClassName: LOGPOINT_GLYPH, hoverMessage: strings.logpoints.tooltip },
      {
        line: 2,
        hollow: true,
        glyphMarginClassName: LOGPOINT_GLYPH_HOLLOW,
        hoverMessage: strings.logpoints.noValue,
      },
    ]);
    expect(logpointDecorations([], new Set([2]))).toEqual([]);
  });

  test("lines read back from sticky ranges are ascending, unique and 1-based", () => {
    expect(linesFromRanges([{ startLineNumber: 5 }, { startLineNumber: 2 }, { startLineNumber: 5 }])).toEqual([2, 5]);
    expect(linesFromRanges([])).toEqual([]);
  });
});
