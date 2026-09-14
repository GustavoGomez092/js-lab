import { COMMAND_CATEGORY_ORDER, type CommandCategory, type CommandContext, type CommandId } from "@jslab/shared";

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

export const CATEGORY_LABELS: Record<CommandCategory, string> = {
  run: "Run",
  file: "File",
  tab: "Tabs",
  edit: "Edit",
  format: "Format",
  view: "View",
  runtime: "Runtime",
  language: "Language",
  theme: "Theme",
  help: "Help",
  app: "JSLab",
};

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

export function buildSections(
  items: readonly PaletteItem[],
  query: string,
  context: "editor" | "output",
  limit = 60,
): PaletteSection[] {
  const hasQuery = query.trim().length > 0;
  const ranked = items
    .map((item, index) => {
      if (!item.enabled) return null;
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
    })
    .slice(0, limit);

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
