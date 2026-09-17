import type { Snippet } from "@jslab/shared";
import { matchTitle } from "../palette/match";

export interface RankedSnippet {
  snippet: Snippet;
  /** Character ranges of the query inside the name, for highlighting. Empty when only the description matched. */
  nameRanges: [number, number][];
}

/**
 * A name match always beats a description-only match, whatever the two raw scores are. `matchTitle` scores a prefix
 * at 300 and a scattered subsequence at 10, so unless the bonus exceeds every score it can return, one snippet's
 * description outranks another snippet's name. This partitions the two groups rather than merely nudging them.
 */
const NAME_BONUS = 1000;

const byName = (a: Snippet, b: Snippet) => a.name.localeCompare(b.name);

interface ScoredSnippet extends RankedSnippet {
  score: number;
}

/**
 * Spec §13.1: "Search box matches name and description." Reuses the palette's own matcher (prefix -> word boundary ->
 * substring -> subsequence) so search feels identical to the command palette -- including the empty query, which
 * `matchTitle` trims and then scores 0 against every title. Browsing therefore falls out of the same pass as
 * searching, ordered by the tie-break below, and needs no branch of its own: a separate fast path for it was written,
 * measured to be behaviourally identical under every mutation, and deleted rather than left unpinnable.
 *
 * Unlike the palette's `buildSections`, the result is never capped -- the panel virtualizes instead. One pass per
 * keystroke, so 500 snippets cost at most 1000 `matchTitle` calls and 500 objects, not 500 DOM nodes.
 */
export function filterSnippets(snippets: readonly Snippet[], query: string): RankedSnippet[] {
  const scored: ScoredSnippet[] = [];
  for (const snippet of snippets) {
    // The description is consulted only when the name misses, which is both the ranking rule and half the work.
    const name = matchTitle(query, snippet.name);
    if (name) {
      scored.push({ snippet, nameRanges: name.ranges, score: name.score + NAME_BONUS });
      continue;
    }
    const description = matchTitle(query, snippet.description);
    if (description) scored.push({ snippet, nameRanges: [], score: description.score });
  }
  scored.sort((a, b) => b.score - a.score || byName(a.snippet, b.snippet));
  return scored.map(({ snippet, nameRanges }) => ({ snippet, nameRanges }));
}
