import { COMMAND_CATEGORY_ORDER, type CommandCategory, type CommandContext, type CommandId } from "@jslab/shared";
import { strings } from "../strings";

export interface MatchResult {
  score: number;
  ranges: [number, number][];
}

const WORD_BREAK = /[\s:(\-/]/;

export function matchTitle(query: string, title: string): MatchResult | null {
  const q = query.trim().toLowerCase();
  const t = title.toLowerCase();
  if (!q) return { score: 0, ranges: [] };
  if (t.startsWith(q)) return { score: 300 - title.length / 100, ranges: [[0, q.length]] };
  for (let index = 1; index < t.length; index++) {
    if (WORD_BREAK.test(t[index - 1] ?? "") && t.startsWith(q, index)) {
      return { score: 200 - index / 100, ranges: [[index, index + q.length]] };
    }
  }
  const contains = t.indexOf(q);
  if (contains >= 0) return { score: 100, ranges: [[contains, contains + q.length]] };
  const ranges: [number, number][] = [];
  let position = 0;
  for (const char of q) {
    if (char === " ") continue;
    const found = t.indexOf(char, position);
    if (found < 0) return null;
    const last = ranges[ranges.length - 1];
    if (last && last[1] === found) last[1] = found + 1;
    else ranges.push([found, found + 1]);
    position = found + 1;
  }
  return { score: 10, ranges };
}

export const CATEGORY_LABELS: Record<CommandCategory, string> = strings.palette.categories;

export interface PaletteItem {
  id: CommandId;
  args?: unknown;
  title: string;
  category: CommandCategory;
  context: CommandContext;
  description: string | null;
  keys: string[];
  enabled: boolean;
}

export type RankedItem = PaletteItem & { ranges: [number, number][] };

export interface PaletteSection {
  category: CommandCategory;
  label: string;
  items: RankedItem[];
}

/** R-M4-PALETTE-HIDE-1: disabled rows render but never take the selection, so `flat[selected]` is always
 * runnable. Returns -1 when every row is disabled -- the caller then drops `aria-activedescendant` and Enter
 * is a genuine no-op, because no listed command can actually run. */
export function firstEnabledIndex(items: readonly { enabled: boolean }[]): number {
  return items.findIndex((item) => item.enabled);
}

/** Moves the selection `direction` rows, skipping disabled ones. Stops at the ends rather than wrapping, which
 * is what the arrow handlers did before this change (`Math.min`/`Math.max`). Falls back to the first enabled
 * row when `from` itself is disabled or out of range. */
export function stepEnabledIndex(items: readonly { enabled: boolean }[], from: number, direction: 1 | -1): number {
  for (let next = from + direction; next >= 0 && next < items.length; next += direction) {
    if (items[next]?.enabled) return next;
  }
  return items[from]?.enabled ? from : firstEnabledIndex(items);
}

export function buildSections(
  items: readonly PaletteItem[],
  query: string,
  context: "editor" | "output",
  limit = 60,
): PaletteSection[] {
  const hasQuery = query.trim().length > 0;
  const ranked = items
    .map((item, index) => {
      // R-M4-PALETTE-HIDE-1: a disabled command is NOT dropped here. Dropping it collapsed "this exists but not
      // right now" into `strings.palette.empty` ("No matching commands"), which is exactly what a typo produces.
      // It still ranks on score alone -- it is not demoted, so it keeps its place next to its siblings and the
      // palette stays a place you can learn the app from. Selection skips it instead (`stepEnabledIndex`).
      if (context === "output" && item.context === "editor") return null;
      const match = matchTitle(query, item.title);
      if (!match) return null;
      const bonus = hasQuery && item.context === context ? 50 : 0;
      return { item: { ...item, ranges: match.ranges }, score: match.score + bonus, index };
    })
    .filter((entry): entry is { item: RankedItem; score: number; index: number } => entry !== null)
    .sort((a, b) => {
      if (!hasQuery) {
        const byCategory =
          COMMAND_CATEGORY_ORDER.indexOf(a.item.category) - COMMAND_CATEGORY_ORDER.indexOf(b.item.category);
        return byCategory !== 0 ? byCategory : a.index - b.index;
      }
      return b.score - a.score || a.index - b.index;
    });
  // FB-m1: browsing with an empty query lists every section (about 105 rows); only a query's ranking is capped.
  if (hasQuery) ranked.splice(limit);

  const sections: PaletteSection[] = [];
  for (const { item } of ranked) {
    let section = sections.find((candidate) => candidate.category === item.category);
    if (!section) {
      section = { category: item.category, label: CATEGORY_LABELS[item.category], items: [] };
      sections.push(section);
    }
    section.items.push(item);
  }
  return sections;
}
