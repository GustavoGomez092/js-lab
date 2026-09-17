import { describe, expect, test } from "bun:test";
import type { DiagnosticPayload } from "@jslab/rpc-schema";
import type * as Monaco from "monaco-editor";
import { attachLogpointGutter } from "../src/editor/logpoint-gutter";
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

/**
 * A minimal `monaco` fake: the two enum members the gutter reads, a Range constructor, a decorations collection
 * that remembers what it was handed, and an `onMouseDown` we can drive. The same shape as `fakeMonaco()` in
 * install-assist.test.ts — enough to run the attachment, nothing more.
 *
 * `length` counts the decorations the collection was handed, while `ranges` is what the *model* can resolve. Real
 * Monaco separates these two the same way (codeEditorWidget.js): `getRanges()` skips every decoration id the
 * current model does not know, but `length` still counts them. That gap is what the last test drives.
 */
function fakeEditorHost() {
  const collection = {
    decorations: [] as { range: { startLineNumber: number }; options: Record<string, unknown> }[],
    ranges: [] as { startLineNumber: number }[],
    get length() {
      return this.decorations.length;
    },
    set(next: { range: { startLineNumber: number }; options: Record<string, unknown> }[]) {
      this.decorations = next;
      this.ranges = next.map((decoration) => decoration.range);
    },
    getRanges() {
      return this.ranges;
    },
    clear() {
      this.decorations = [];
      this.ranges = [];
    },
  };
  let mouseDown: ((event: unknown) => void) | null = null;
  let contentChanged: (() => void) | null = null;
  const disposed: string[] = [];
  const editor = {
    createDecorationsCollection: () => collection,
    onMouseDown: (listener: (event: unknown) => void) => {
      mouseDown = listener;
      return { dispose: () => disposed.push("mouseDown") };
    },
    onDidChangeModelContent: (listener: () => void) => {
      contentChanged = listener;
      return { dispose: () => disposed.push("content") };
    },
  } as unknown as Monaco.editor.IStandaloneCodeEditor;
  const monaco = {
    Range: class {
      constructor(
        public startLineNumber: number,
        public startColumn: number,
        public endLineNumber: number,
        public endColumn: number,
      ) {}
    },
    editor: {
      MouseTargetType: { GUTTER_GLYPH_MARGIN: 2 },
      TrackedRangeStickiness: { NeverGrowsWhenTypingAtEdges: 1 },
    },
  } as unknown as typeof Monaco;
  return {
    monaco,
    editor,
    collection,
    disposed,
    clickGutter: (lineNumber: number) => mouseDown?.({ target: { type: 2, position: { lineNumber } } }),
    clickText: (lineNumber: number) => mouseDown?.({ target: { type: 6, position: { lineNumber } } }),
    edit: () => contentChanged?.(),
  };
}

describe("logpoint gutter (spec §6.3)", () => {
  test("a glyph-margin click toggles that line, and a click in the text does nothing", () => {
    const host = fakeEditorHost();
    const toggled: number[] = [];
    attachLogpointGutter(host.monaco, host.editor, {
      lines: () => [],
      hollow: () => new Set(),
      toggle: (line) => toggled.push(line),
      reconcile: () => {},
    });
    host.clickGutter(4);
    host.clickText(9);
    expect(toggled).toEqual([4]);
  });

  test("render() sets one sticky decoration per line, hollow where there is nothing to log", () => {
    const host = fakeEditorHost();
    let lines: number[] = [2, 5];
    const gutter = attachLogpointGutter(host.monaco, host.editor, {
      lines: () => lines,
      hollow: () => new Set([5]),
      toggle: () => {},
      reconcile: () => {},
    });
    gutter.render();
    expect(
      host.collection.decorations.map((decoration) => [
        decoration.range.startLineNumber,
        decoration.options.glyphMarginClassName,
        decoration.options.stickiness,
      ]),
    ).toEqual([
      [2, LOGPOINT_GLYPH, 1],
      [5, LOGPOINT_GLYPH_HOLLOW, 1],
    ]);
    lines = [];
    gutter.render();
    expect(host.collection.decorations).toEqual([]);
  });

  test("an edit reconciles the store with where the sticky decorations actually moved to", () => {
    const host = fakeEditorHost();
    const reconciled: number[][] = [];
    const gutter = attachLogpointGutter(host.monaco, host.editor, {
      lines: () => [2],
      hollow: () => new Set(),
      toggle: () => {},
      reconcile: (next) => reconciled.push(next),
    });
    gutter.render();
    // Monaco moved the decoration down two lines while the user typed above it.
    host.collection.ranges = [{ startLineNumber: 4 }];
    host.edit();
    expect(reconciled).toEqual([[4]]);
    gutter.dispose();
    expect(host.disposed.sort()).toEqual(["content", "mouseDown"]);
  });

  test("an edit right after a model swap does not reconcile the new tab's logpoints away", () => {
    const host = fakeEditorHost();
    const reconciled: number[][] = [];
    const gutter = attachLogpointGutter(host.monaco, host.editor, {
      lines: () => [2],
      hollow: () => new Set(),
      toggle: () => {},
      reconcile: (next) => reconciled.push(next),
    });
    gutter.render();
    // A tab switch: `setModel` leaves the collection holding the previous model's decoration ids, so the new
    // model resolves none of them. Reading those absent ranges back as the truth would report "no logpoints"
    // and delete the lines the newly shown tab actually has.
    host.collection.ranges = [];
    host.edit();
    expect(reconciled).toEqual([]);
  });
});
