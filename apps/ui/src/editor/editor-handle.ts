export interface OffsetEdit {
  start: number;
  end: number;
  text: string;
}

export interface TsDiagnostic {
  code: number;
  message: string;
  line: number;
}

/** The mounted Monaco editor, as seen by commands, formatting and E2E automation. */
export interface EditorHandle {
  /** Types text at the cursor, like a keyboard would. `replace` selects the whole buffer first. */
  typeText(text: string, replace: boolean): void;
  focus(): void;
  hasFocus(): boolean;
  /** Runs a Monaco editor action; false when the action id doesn't exist in this Monaco build. */
  runAction(actionId: string): boolean;
  /** Replaces the whole buffer as one undoable edit. */
  replaceAll(text: string): void;
  getValue(): string;
  getCursorOffset(): number;
  /** The 1-based lines covered by the primary selection (a selection ending at column 1 excludes that line). */
  getSelectedLineRange(): { startLine: number; endLine: number } | null;
  getLines(startLine: number, endLine: number): string[];
  /** Replaces whole lines as one undoable edit, keeping the model's line ending. */
  replaceLines(startLine: number, endLine: number, lines: string[]): void;
  /** Applies non-overlapping offset edits (computed against the current text) as one undoable step. */
  applyOffsetEdits(edits: OffsetEdit[], cursorOffset?: number): void;
  missingActions(ids: readonly string[]): string[];
  /** Settings-driven editor options currently in effect (E2E verification). */
  getOptions(): Record<string, unknown>;
  /** Sends every pending view-state save now (X1, before quit). */
  flushViewState(): void;
  /** Monaco's current TypeScript markers for the shown model (E2E verification). */
  typeDiagnostics(): Promise<TsDiagnostic[]>;
  /** TypeScript completion names at an offset in the shown model (E2E verification). */
  completionsAt(offset: number): Promise<string[]>;
}

let active: EditorHandle | null = null;

export function setEditorHandle(handle: EditorHandle | null): void {
  active = handle;
}

export function getEditorHandle(): EditorHandle | null {
  return active;
}
