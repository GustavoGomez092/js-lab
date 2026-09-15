import type { OffsetEdit } from "../editor/editor-handle";

/** Lines with their line terminators kept, so offsets add up exactly. */
function splitLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

const MAX_LCS_CELLS = 4_000_000;

/**
 * Minimal line-level edits (offsets in `before`) that turn `before` into `after` (spec §6.4). Untouched lines
 * keep their decorations, folds and undo history. A very large changed middle falls back to one replacement.
 */
export function computeEdits(before: string, after: string): OffsetEdit[] {
  if (before === after) return [];
  const a = splitLines(before);
  const b = splitLines(after);

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  let offset = 0;
  for (let index = 0; index < start; index++) offset += (a[index] ?? "").length;
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);

  if (midA.length * midB.length > MAX_LCS_CELLS) {
    const removed = midA.join("");
    return [{ start: offset, end: offset + removed.length, text: midB.join("") }];
  }

  const n = midA.length;
  const m = midB.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    const row = lcs[i] as Uint32Array;
    const below = lcs[i + 1] as Uint32Array;
    for (let j = m - 1; j >= 0; j--) {
      row[j] = midA[i] === midB[j] ? (below[j + 1] ?? 0) + 1 : Math.max(below[j] ?? 0, row[j + 1] ?? 0);
    }
  }

  const edits: OffsetEdit[] = [];
  let hunk: { start: number; removed: string; added: string } | null = null;
  const flush = () => {
    if (hunk) edits.push({ start: hunk.start, end: hunk.start + hunk.removed.length, text: hunk.added });
    hunk = null;
  };

  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && midA[i] === midB[j]) {
      flush();
      offset += (midA[i] ?? "").length;
      i++;
      j++;
    } else if (j < m && (i === n || (lcs[i]?.[j + 1] ?? 0) >= (lcs[i + 1]?.[j] ?? 0))) {
      hunk ??= { start: offset, removed: "", added: "" };
      hunk.added += midB[j];
      j++;
    } else {
      hunk ??= { start: offset, removed: "", added: "" };
      hunk.removed += midA[i];
      offset += (midA[i] ?? "").length;
      i++;
    }
  }
  flush();
  return edits;
}

export function applyEdits(text: string, edits: readonly OffsetEdit[]): string {
  let out = text;
  for (const edit of [...edits].sort((x, y) => y.start - x.start)) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }
  return out;
}
