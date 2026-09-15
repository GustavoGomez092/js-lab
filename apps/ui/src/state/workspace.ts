import type { TabState } from "@jslab/shared";

export const EDITOR_SIZE_RESET = 50;

export function clampEditorSize(size: number): number {
  return Math.min(90, Math.max(10, Math.round(size)));
}

export function insertAfterActive(order: string[], activeId: string | null, id: string): string[] {
  if (order.includes(id)) return order;
  const next = [...order];
  const index = activeId ? next.indexOf(activeId) : -1;
  next.splice(index < 0 ? next.length : index + 1, 0, id);
  return next;
}

export function isPermutation(current: readonly string[], next: readonly string[]): boolean {
  return (
    next.length === current.length && new Set(next).size === next.length && next.every((id) => current.includes(id))
  );
}

/** Tab → Rename: an empty name gives the tab back its derived title (spec §7.3). */
export function renamePatch(title: string): Pick<TabState, "title" | "titleIsCustom"> {
  const trimmed = title.trim().slice(0, 200);
  return trimmed ? { title: trimmed, titleIsCustom: true } : { title: "Untitled", titleIsCustom: false };
}

/** Cmd+1…8 select by position; Cmd+9 always selects the last tab. */
export function gotoTabIndex(order: readonly string[], n: number): string | null {
  if (n === 9) return order[order.length - 1] ?? null;
  return order[n - 1] ?? null;
}
