import { deriveTitle, isDirty, type TabState } from "@jslab/shared";
import { strings } from "../strings";

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
  /** Entries currently cached (RR2-m1: for tests, and to bound App.tsx's single-tab toolbar-title cache). */
  size(): number;
}

/**
 * Per-tab title and dirty state, recomputed only when the tab's buffer string or its title/file fields change (FB-I2).
 * Buffers are immutable strings replaced on every edit, so an unchanged tab is an `===` hit and typing in one tab
 * never rehashes or rescans the others.
 */
export function createTabSummaryCache(
  compute: { title(tab: SummaryTab, code: string): string; dirty(tab: SummaryTab, code: string): boolean } = {
    // R-M5E-DT-1: deriveTitle's own fallback parameter defaults to the English literal "Untitled" -- the
    // caller supplies the localized string (spec §17, packages/shared/src/tabs.ts:37-41). This is the real
    // tab bar (TabBar.tsx calls `summaries.title(tab, code)`), so it must not use that hard-coded default.
    //
    // Not keyed into the cache below: `strings.tabs.untitled` is read fresh on every miss rather than
    // captured once, but that only matters if the fallback can change during one cache's lifetime. It can't --
    // `app.uiLanguage` is a restart-required setting (settings/fields.ts) and the locale is resolved once,
    // synchronously, from the URL at module load (i18n/index.ts), before this module or `strings.ts` even
    // finishes evaluating. A locale change means a fresh page load, which builds a fresh `TabBar` and a fresh
    // cache via `useState(createTabSummaryCache)` -- so no cache instance ever sees the fallback change under it.
    title: (tab, code) => deriveTitle(tab, code, strings.tabs.untitled),
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
    size() {
      return entries.size;
    },
  };
}
