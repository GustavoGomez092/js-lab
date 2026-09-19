import { isSafeExternalUrl } from "@jslab/rpc-schema";

/**
 * OU-13. One run of output text: either ordinary text, or a URL the user may open.
 *
 * `href` is always byte-for-byte the same string as `text` when it is set. That is not an implementation detail
 * to be tidied away later -- it is the property that makes the feature safe to look at. Output text is written
 * by the user's own running program, so any shortening, decoration or normalisation applied to the LABEL would
 * let the thing on screen differ from the thing that opens. Keeping them the same object makes that split
 * impossible by construction rather than by care.
 */
export interface TextSegment {
  text: string;
  href: string | null;
}

/**
 * Candidate runs: an explicit http(s) scheme followed by non-whitespace.
 *
 * Deliberately narrow. It never invents a scheme for `example.com` or `www.example.com`, because a guessed
 * scheme is a destination the user was never shown. The case-insensitive flag only lets `HTTPS://…` be found;
 * whether it may be opened is still `isSafeExternalUrl`'s decision, never this pattern's.
 */
const CANDIDATE = /https?:\/\/\S+/gi;

/** Trailing characters far more often sentence punctuation than part of the URL. */
const TRAILING_PUNCTUATION = ".,;:!?'\"";

/**
 * Drops trailing punctuation from a candidate, so `see https://example.com.` links `https://example.com` rather
 * than a URL with a full stop welded onto it.
 *
 * A closing bracket is dropped only when the candidate holds no matching opener, which is what keeps
 * `https://en.wikipedia.org/wiki/Foo_(bar)` intact while still trimming the `)` in `(see https://example.com)`.
 */
function trimTrailingPunctuation(candidate: string): string {
  let text = candidate;
  while (text.length > 0) {
    const last = text[text.length - 1] as string;
    if (TRAILING_PUNCTUATION.includes(last)) {
      text = text.slice(0, -1);
      continue;
    }
    const opener = last === ")" ? "(" : last === "]" ? "[" : last === "}" ? "{" : null;
    if (opener !== null && !text.includes(opener)) {
      text = text.slice(0, -1);
      continue;
    }
    break;
  }
  return text;
}

/**
 * Splits output text into plain runs and openable URLs.
 *
 * Nothing becomes a link that `isSafeExternalUrl` has not approved, so a `javascript:` URL is not merely
 * unmatched by the pattern above -- it could not pass the guard even if the pattern were widened.
 */
export function linkify(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  let index = 0;
  for (const match of text.matchAll(CANDIDATE)) {
    const start = match.index;
    const candidate = trimTrailingPunctuation(match[0]);
    if (!isSafeExternalUrl(candidate)) continue;
    if (start > index) segments.push({ text: text.slice(index, start), href: null });
    // `href` IS `candidate`: the very characters rendered on screen are the ones handed to the browser.
    segments.push({ text: candidate, href: candidate });
    index = start + candidate.length;
  }
  if (index < text.length) segments.push({ text: text.slice(index), href: null });
  return segments;
}

/** Whether this text holds anything openable, without building the segment list. */
export function hasLink(text: string): boolean {
  return linkify(text).some((segment) => segment.href !== null);
}
