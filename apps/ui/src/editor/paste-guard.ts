export const LARGE_PASTE_BYTES = 5 * 1024 * 1024;

/**
 * Pastes over 5 MB wait for confirmation (spec §6.3). Listens in the capture phase on the editor host, so
 * Monaco never sees a large paste until the user agrees; then `insert` applies it.
 */
export function installPasteGuard(
  target: HTMLElement,
  confirm: (bytes: number) => Promise<boolean>,
  insert: (text: string) => void,
): () => void {
  const onPaste = (event: Event) => {
    const text = (event as ClipboardEvent).clipboardData?.getData("text/plain") ?? "";
    // UTF-8 needs at most 4 bytes per UTF-16 unit, so text under a quarter of the limit can skip the encoder.
    const bytes = text.length > LARGE_PASTE_BYTES / 4 ? new TextEncoder().encode(text).length : text.length;
    if (bytes <= LARGE_PASTE_BYTES) return;
    event.preventDefault();
    event.stopPropagation();
    void confirm(bytes).then((ok) => {
      if (ok) insert(text);
    });
  };
  target.addEventListener("paste", onPaste, true);
  return () => target.removeEventListener("paste", onPaste, true);
}
