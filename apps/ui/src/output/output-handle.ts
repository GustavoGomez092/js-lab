/**
 * The mounted output list, as seen by the focus commands (UI item 2). Mirrors `editor-handle.ts`: the commands
 * live outside React, and the scroller they need is a ref inside `OutputPanel`.
 *
 * A null handle means there is nothing to focus -- the Output panel is hidden, or the Web View is docked in its
 * place -- and `view.focusOutput` reports itself disabled rather than silently doing nothing.
 */
export interface OutputHandle {
  focus(): void;
}

let active: OutputHandle | null = null;

export function setOutputHandle(handle: OutputHandle | null): void {
  active = handle;
}

export function getOutputHandle(): OutputHandle | null {
  return active;
}
