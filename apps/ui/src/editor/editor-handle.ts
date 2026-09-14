/** The mounted Monaco editor, as seen by commands and E2E automation. Task 12 extends this interface. */
export interface EditorHandle {
  /** Types text at the cursor, like a keyboard would. `replace` selects the whole buffer first. */
  typeText(text: string, replace: boolean): void;
  focus(): void;
}

let active: EditorHandle | null = null;

export function setEditorHandle(handle: EditorHandle | null): void {
  active = handle;
}

export function getEditorHandle(): EditorHandle | null {
  return active;
}
