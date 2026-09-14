import { type ClosedTab, EXTENSIONS, MAX_CLOSED_TABS, type TabState } from "./session";
import type { Language } from "./settings";

/** session.ts owns the one literal extension table; this re-exports it under the tab-helpers name. */
export const LANGUAGE_EXTENSIONS: Record<Language, string> = EXTENSIONS;

export function extensionFor(language: Language): string {
  return LANGUAGE_EXTENSIONS[language];
}

/** Spec §10.2: .ts/.mts/.cts → TypeScript, .tsx → TSX, .jsx → JSX, anything else → JavaScript. */
export function languageForPath(path: string): Language {
  const lower = path.toLowerCase();
  if (/\.(ts|mts|cts)$/.test(lower)) return "typescript";
  if (lower.endsWith(".tsx")) return "tsx";
  if (lower.endsWith(".jsx")) return "jsx";
  return "javascript";
}

export function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

export const TITLE_MAX = 30;

export function deriveTitle(tab: Pick<TabState, "title" | "titleIsCustom" | "filePath">, code: string): string {
  if (tab.titleIsCustom && tab.title.trim()) return tab.title;
  if (tab.filePath) return baseName(tab.filePath);
  const first = code
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!first) return "Untitled";
  return first.length > TITLE_MAX ? `${first.slice(0, TITLE_MAX - 1).trimEnd()}…` : first;
}

/** FNV-1a over UTF-16 code units, prefixed with the length. The same value is computed in Main and the UI. */
export function contentHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${text.length.toString(16)}-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

/** Only saved-file tabs show a dirty dot; scratch tabs are auto-persisted (spec §7.3). */
export function isDirty(tab: Pick<TabState, "filePath" | "lastSavedHash">, code: string): boolean {
  return tab.filePath !== null && tab.lastSavedHash !== contentHash(code);
}

export function pushClosed(stack: ClosedTab[], entry: ClosedTab): { stack: ClosedTab[]; evicted: ClosedTab[] } {
  const next = [entry, ...stack.filter((existing) => existing.tab.id !== entry.tab.id)];
  return { stack: next.slice(0, MAX_CLOSED_TABS), evicted: next.slice(MAX_CLOSED_TABS) };
}

export function adjacentTabId(order: string[], activeId: string, delta: number): string | null {
  if (order.length === 0) return null;
  const index = order.indexOf(activeId);
  if (index < 0) return order[0] ?? null;
  const next = (((index + delta) % order.length) + order.length) % order.length;
  return order[next] ?? null;
}

export function tabAfterClose(order: string[], closingId: string, activeId: string): string | null {
  const remaining = order.filter((id) => id !== closingId);
  if (remaining.length === 0) return null;
  if (activeId !== closingId && remaining.includes(activeId)) return activeId;
  const index = order.indexOf(closingId);
  return order[index + 1] ?? order[index - 1] ?? remaining[0] ?? null;
}

export function moveTab(order: string[], id: string, toIndex: number): string[] {
  if (!order.includes(id)) return order;
  const rest = order.filter((candidate) => candidate !== id);
  const target = Math.max(0, Math.min(rest.length, toIndex));
  return [...rest.slice(0, target), id, ...rest.slice(target)];
}
