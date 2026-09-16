import type { WebDialogEntry } from "../state/output";
import { strings } from "../strings";

/**
 * JSLab's own non-blocking stand-in for `alert()` (spec §5.12, M0-S4; Task 13). Deliberately NOT a modal: it never
 * covers the editor or the rest of the output, has no backdrop, and traps no focus -- every other tab, and this
 * one's own editor and output, keep working while it's shown, which is the entire point of the shim (a real
 * browser's `alert()` would freeze the page; this runtime cannot and must not). Rendered inside the Console tile's
 * normal document flow (`OutputPanel.tsx`) rather than positioned over the Web View tile: a docked
 * `<electrobun-webview>` needs its own resolved occlusion story (tracked separately), and a page message showing
 * beside the output it came from, rather than floating over live page content, is itself a reasonable place for it.
 *
 * `dialogs` is a FIFO queue (`state/output.ts`): only the front one is shown, so an `alert()` storm can't paper the
 * screen -- the rest wait their turn and are counted, never dropped.
 */
export function WebDialog({
  dialogs,
  onDismiss,
}: {
  dialogs: readonly WebDialogEntry[];
  onDismiss(key: string): void;
}) {
  const shown = dialogs[0];
  if (!shown) return null;
  const queued = dialogs.length - 1;
  return (
    <div className="web-dialog" role="status" aria-label={strings.webDialog.region}>
      <span className="web-dialog-text">{shown.text}</span>
      {queued > 0 && <span className="web-dialog-queued">{strings.webDialog.queued(queued)}</span>}
      <button type="button" className="web-dialog-dismiss" onClick={() => onDismiss(shown.key)}>
        {strings.webDialog.dismiss}
      </button>
    </div>
  );
}
