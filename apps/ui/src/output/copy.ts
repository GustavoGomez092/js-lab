import { type DisplayEvent, type OutputEntry, visibleEntries } from "../state/output";
import type { AppState } from "../state/store";
import { applyFilter } from "./filters";
import { entryToJsonText, entryToText } from "./text";

/** Wraps the Clipboard API so a denied or failed write reports a status instead of throwing (Copy All). */
export async function copyEntriesToClipboard(
  text: string,
  clipboard: Pick<Clipboard, "writeText"> = navigator.clipboard,
): Promise<"copied" | "failed"> {
  try {
    await clipboard.writeText(text);
    return "copied";
  } catch {
    return "failed";
  }
}

/** Everything Copy All needs, so the toolbar button and the `output.copyAll` command ask the same question. */
export type CopyAllState = Pick<AppState, "output" | "settings" | "outputFilter">;

/**
 * R-M2-T19A-1 (spec §7.2): Copy All copies the entries visible under the current filter chip, not the whole
 * output. This is the single owner of that rule. Both entry points -- the toolbar button in `OutputPanel` and the
 * `output.copyAll` command behind the palette and the menu -- resolve their entries here, because they had already
 * drifted apart once: the command mapped over `visibleEntries` and never read `outputFilter`, so with the Errors
 * chip selected the button copied the errors and the palette copied every row.
 */
export function copyAllEntries(state: CopyAllState): OutputEntry[] {
  const showUndefined = state.settings?.run.showUndefined ?? false;
  return applyFilter(visibleEntries(state.output, { showUndefined }), state.outputFilter);
}

/** The exact text Copy All puts on the clipboard, for whichever entries the chip leaves visible. */
export function copyAllText(state: CopyAllState): string {
  return copyAllEntries(state)
    .map((entry) => entryToText(entry.event))
    .join("\n");
}

/** OU-10: the two things a single output row's entry menu can put on the clipboard. */
export type CopyEntryKind = "text" | "json";

/** OU-10: what Copy / Copy as JSON copy for one row -- the row's own text, or its value as JSON. */
export function entryCopyText(event: DisplayEvent, kind: CopyEntryKind): string {
  return kind === "json" ? entryToJsonText(event) : entryToText(event);
}

/**
 * OU-10: one row's entry-menu copy, start to finish.
 *
 * Routed through `copyEntriesToClipboard` rather than touching `navigator.clipboard` directly, so a denied or
 * failed write reports `"failed"` here exactly as it already does for Copy All -- the entry menu reuses that
 * status chip and its strings instead of introducing a third way to say the clipboard refused.
 */
export function copyEntry(
  event: DisplayEvent,
  kind: CopyEntryKind,
  clipboard?: Pick<Clipboard, "writeText">,
): Promise<"copied" | "failed"> {
  return copyEntriesToClipboard(entryCopyText(event, kind), clipboard ?? navigator.clipboard);
}
