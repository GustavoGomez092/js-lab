export const LARGE_PASTE_BYTES = 5 * 1024 * 1024;

/**
 * Pastes over 5 MB wait for confirmation (spec §6.3). Listens in the capture phase on the editor host, so
 * Monaco never sees a large paste until the user agrees; then `insert` applies it with what `capture` returned at
 * paste time (T18-m-paste: the model that was attached, since a menu click can switch tabs under the confirm).
 */
export function installPasteGuard<C>(
  target: HTMLElement,
  confirm: (bytes: number) => Promise<boolean>,
  capture: () => C,
  insert: (text: string, captured: C) => void,
): () => void {
  const onPaste = (event: Event) => {
    const text = (event as ClipboardEvent).clipboardData?.getData("text/plain") ?? "";
    // UTF-8 needs at most 4 bytes per UTF-16 unit, so text under a quarter of the limit can skip the encoder.
    const bytes = text.length > LARGE_PASTE_BYTES / 4 ? new TextEncoder().encode(text).length : text.length;
    if (bytes <= LARGE_PASTE_BYTES) return;
    event.preventDefault();
    event.stopPropagation();
    const captured = capture();
    void confirm(bytes).then((ok) => {
      if (ok) insert(text, captured);
    });
  };
  target.addEventListener("paste", onPaste, true);
  return () => target.removeEventListener("paste", onPaste, true);
}

/**
 * The slice of a Monaco editor a confirmed paste needs. `IStandaloneCodeEditor` satisfies it; tests use a fake.
 * `R` is the (looser) range type `executeEdits` takes for each edit; `S` is the (more specific) selection type
 * `getSelections` returns and `executeEdits`'s end-cursor-state computer must return, mirroring Monaco's own
 * `IRange`/`Selection` split.
 */
export interface PasteEditor<M, R, S extends R = R> {
  getModel(): M | null;
  getSelections(): S[] | null;
  pushUndoStop(): unknown;
  executeEdits(
    source: string,
    edits: { range: R; text: string }[],
    /** RR2-m3: computes the end cursor state from Monaco's inverse edit operations. */
    endCursorState?: (inverseEditOperations: { range: R }[]) => S[],
  ): unknown;
}

/**
 * Inserts a confirmed paste into `model` only if it is still the attached model, replacing every selection as one
 * undo step (T18-m-paste). Each selection collapses to a caret at the end of its inserted range, as a native paste
 * leaves it (RR2-m3): `toCaretAtEnd` builds that caret from the inverse operation's range, in the same undo-stop
 * bracket as the edit itself. Returns whether anything was inserted.
 */
export function pasteInto<M, R, S extends R = R>(
  editor: PasteEditor<M, R, S>,
  model: M | null,
  text: string,
  toCaretAtEnd?: (insertedRange: R) => S,
): boolean {
  if (model === null || editor.getModel() !== model) return false;
  const selections = editor.getSelections();
  if (!selections || selections.length === 0) return false;
  editor.pushUndoStop();
  editor.executeEdits(
    "paste",
    selections.map((range) => ({ range, text })),
    toCaretAtEnd ? (inverseEditOperations) => inverseEditOperations.map((op) => toCaretAtEnd(op.range)) : undefined,
  );
  editor.pushUndoStop();
  return true;
}
