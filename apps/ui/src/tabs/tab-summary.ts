import { deriveTitle, isDirty, type TabState } from "@jslab/shared";

type SummaryTab = Pick<TabState, "id" | "title" | "titleIsCustom" | "filePath" | "lastSavedHash">;

interface Entry {
  code: string;
  title: string;
  titleIsCustom: boolean;
  filePath: string | null;
  lastSavedHash: string | null;
  derivedTitle?: string;
  dirty?: boolean;
}

export interface TabSummaryCache {
  title(tab: SummaryTab, code: string): string;
  dirty(tab: SummaryTab, code: string): boolean;
  /** Forgets tabs that are no longer open. */
  retain(openIds: ReadonlySet<string>): void;
}

/**
 * Per-tab title and dirty state, recomputed only when the tab's buffer string or its title/file fields change (FB-I2).
 * Buffers are immutable strings replaced on every edit, so an unchanged tab is an `===` hit and typing in one tab
 * never rehashes or rescans the others.
 */
export function createTabSummaryCache(
  compute: { title(tab: SummaryTab, code: string): string; dirty(tab: SummaryTab, code: string): boolean } = {
    title: deriveTitle,
    dirty: isDirty,
  },
): TabSummaryCache {
  const entries = new Map<string, Entry>();

  const entryFor = (tab: SummaryTab, code: string): Entry => {
    const current = entries.get(tab.id);
    if (
      current &&
      current.code === code &&
      current.title === tab.title &&
      current.titleIsCustom === tab.titleIsCustom &&
      current.filePath === tab.filePath &&
      current.lastSavedHash === tab.lastSavedHash
    ) {
      return current;
    }
    const next: Entry = {
      code,
      title: tab.title,
      titleIsCustom: tab.titleIsCustom,
      filePath: tab.filePath,
      lastSavedHash: tab.lastSavedHash,
    };
    entries.set(tab.id, next);
    return next;
  };

  return {
    title(tab, code) {
      const entry = entryFor(tab, code);
      entry.derivedTitle ??= compute.title(tab, code);
      return entry.derivedTitle;
    },
    dirty(tab, code) {
      const entry = entryFor(tab, code);
      entry.dirty ??= compute.dirty(tab, code);
      return entry.dirty;
    },
    retain(openIds) {
      for (const id of entries.keys()) if (!openIds.has(id)) entries.delete(id);
    },
  };
}
