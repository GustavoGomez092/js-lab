import type * as Monaco from "monaco-editor";
import { linesFromRanges, logpointDecorations } from "./logpoints";

export interface LogpointGutterDeps {
  /** The tab's logpoint lines right now (the store's `logpoints` mirror). */
  lines(): readonly number[];
  /** Lines the latest run reported as having nothing to log (`hollowLogpointLines`). */
  hollow(): ReadonlySet<number>;
  /** A glyph-margin click on `line`. */
  toggle(line: number): void;
  /** Where the sticky decorations ended up after an edit; the store adopts these as the new line set. */
  reconcile(lines: number[]): void;
}

export interface LogpointGutter {
  /** Rewrites the decorations from `deps.lines()` and `deps.hollow()`. */
  render(): void;
  dispose(): void;
}

/**
 * The logpoint glyph margin (spec §6.3). All the decision-making lives in `./logpoints.ts`; this file owns only
 * the Monaco objects — the collection, the mouse listener and the content listener — so it stays thin enough to
 * run against a fake in tests, exactly as `registerInstallAssist` does.
 *
 * Decorations carry `stickiness: NeverGrowsWhenTypingAtEdges`, so Monaco moves each dot with its line through
 * edits (spec §6.3, RunJS #731) instead of leaving it pinned to a line number. After each edit the decorations,
 * not the store, are the truth about where the logpoints now are, so their ranges are read back and reconciled.
 */
export function attachLogpointGutter(
  monaco: typeof Monaco,
  editor: Monaco.editor.IStandaloneCodeEditor,
  deps: LogpointGutterDeps,
): LogpointGutter {
  const collection = editor.createDecorationsCollection();

  const render = () => {
    collection.set(
      logpointDecorations(deps.lines(), deps.hollow()).map((decoration) => ({
        range: new monaco.Range(decoration.line, 1, decoration.line, 1),
        options: {
          glyphMarginClassName: decoration.glyphMarginClassName,
          glyphMarginHoverMessage: { value: decoration.hoverMessage },
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        },
      })),
    );
  };

  const mouse = editor.onMouseDown((event) => {
    if (event.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
    const line = event.target.position?.lineNumber;
    if (line !== undefined) deps.toggle(line);
  });

  // After an edit, report where the dots actually are. `setLogpoints` keeps the previous array identity when the
  // set is unchanged (store.ts), so a plain edit that moved nothing does not schedule a second run.
  const content = editor.onDidChangeModelContent(() => {
    if (deps.lines().length === 0) return;
    const ranges = collection.getRanges();
    // A tab switch leaves the collection holding the *previous* model's decoration ids until `render()` runs
    // again: Monaco's `getRanges()` silently drops every id the current model cannot resolve, while `length`
    // still counts them (codeEditorWidget.js). Reading those absent ranges back as the truth would reconcile
    // the newly shown tab's logpoints to `[]` and delete them. A count mismatch means these decorations are not
    // on this model, so there is nothing trustworthy to reconcile from.
    if (ranges.length !== collection.length) return;
    deps.reconcile(linesFromRanges(ranges));
  });

  return {
    render,
    dispose: () => {
      mouse.dispose();
      content.dispose();
      collection.clear();
    },
  };
}
