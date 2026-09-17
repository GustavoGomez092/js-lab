import type { Snippet } from "@jslab/shared";

/**
 * Monaco snippet syntax (spec §13.2). The braced forms -- `${1}`, `${1:url}`, `${1|a,b|}` -- are unambiguous, because
 * nothing but a tab stop is ever spelled that way.
 */
const BRACED_PLACEHOLDER = /\$\{\d+[^}]*\}/;

/**
 * A bare `$<digits>` is ambiguous: `$1` is a tab stop and `$5` is five dollars, and the text alone cannot tell them
 * apart. Ruling R-M5b-D1 settles it by where the numbering starts -- tab stops run from 1 with 0 as the exit, so a
 * real template always carries a `$1` or a `$0`, while a body whose only dollars are `$5` and `$10` is a price list.
 * The `(?!\d)` is what keeps `$10` from being read as a `$1` with a stray 0 after it.
 */
const ENTRY_TAB_STOP = /\$[01](?!\d)/;

/** Every tab stop, for stripping. The optional `:` is what divides `${1:url}`'s default text from its number. */
const PLACEHOLDER_ALL = /\$(?:\d+|\{\d+:?([^}]*)\})/g;

export function hasPlaceholders(body: string): boolean {
  return BRACED_PLACEHOLDER.test(body) || ENTRY_TAB_STOP.test(body);
}

/**
 * Spec §13.2: "A body without placeholders is inserted literally, with `$` escaped." A body that has them is a
 * template exactly as written, so a `${price}` sitting beside a real tab stop stays the author's problem rather than
 * ours -- the only reading that lets a body mix shell-style and snippet-style dollars deliberately.
 */
export function snippetTemplate(body: string): string {
  return hasPlaceholders(body) ? body : body.replaceAll("$", "\\$");
}

/**
 * The fallback text for a Monaco build with no snippet controller, and the content of a snippet's new tab (Task 9,
 * Task 10): tab stops vanish, and a placeholder leaves its default text behind, which is the closest literal
 * rendering of the author's intent. A body that is not a template is left exactly alone, so the `$5` that
 * `snippetTemplate` escapes is not quietly deleted here instead.
 */
export function plainInsertion(body: string): string {
  if (!hasPlaceholders(body)) return body;
  return body.replace(PLACEHOLDER_ALL, (_match, placeholder: string | undefined) => placeholder ?? "");
}

/** The characters a snippet name may contain (spec §13.1's `^[\w$-]+$`), anchored at the caret. */
const TRAILING_NAME = /[\w$-]+$/;

export function triggerWord(textBeforeCursor: string): string {
  return TRAILING_NAME.exec(textBeforeCursor)?.[0] ?? "";
}

export interface SnippetExpansion {
  snippet: Snippet;
  /** How many characters before the caret the trigger word occupies, and so how many to replace. */
  deleteBefore: number;
}

/**
 * Ruling R-M5b-7, channel 1: Tab expands only when the trailing word IS a snippet name. Names are unique, so an
 * exact match is never ambiguous and never needs a list. Anything else returns null, which is what makes the
 * `snippets.expand` command report `isEnabled() === false` and leaves Tab to Monaco.
 */
export function expansionFor(textBeforeCursor: string, snippets: readonly Snippet[]): SnippetExpansion | null {
  const word = triggerWord(textBeforeCursor);
  if (!word) return null;
  const lowered = word.toLowerCase();
  const snippet = snippets.find((candidate) => candidate.name.toLowerCase() === lowered);
  return snippet ? { snippet, deleteBefore: word.length } : null;
}

/**
 * Ruling R-M5b-7, channel 2 (spec §13.3): snippets whose name starts with the typed word, case-insensitively --
 * except that an exact match collapses the list to itself. That is what keeps the spec's "suggested even when the
 * full name has been typed" from turning into VS Code's open complaint that an exact match ranks no higher than its
 * longer siblings (issues #244170, #66621; see scratchpad/m5-ui-patterns.md §1).
 */
export function completionsFor(word: string, snippets: readonly Snippet[]): Snippet[] {
  if (!word) return [];
  const lowered = word.toLowerCase();
  const exact = snippets.find((candidate) => candidate.name.toLowerCase() === lowered);
  if (exact) return [exact];
  return snippets
    .filter((candidate) => candidate.name.toLowerCase().startsWith(lowered))
    .sort((a, b) => a.name.localeCompare(b.name));
}
