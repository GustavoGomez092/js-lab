/**
 * A very small Markdown reader for assistant replies (spec §14.1: "rendered Markdown with syntax-highlighted
 * code blocks").
 *
 * It parses to a tree of BLOCKS AND SPANS, never to an HTML string. That is the security decision in this file:
 * an assistant reply is remote text arriving in the main window, which holds the full RPC, so producing HTML for
 * `dangerouslySetInnerHTML` would make any parser bug into script execution with full privileges. React renders
 * these nodes as elements and escapes every string, so there is no path from reply text to markup at all. (The
 * one exception is a code block's *highlighted* form, which goes through the same injected, escaping `colorize`
 * seam the snippets panel documents -- see `SnippetColorize`.)
 *
 * No Markdown library is used because none is in this workspace's lockfile and the lockfile is fixed. The subset
 * below is what a code assistant actually emits: fenced code, headings, list items, paragraphs, and inline code,
 * bold and italic.
 */

export type MarkdownSpan =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "strong"; text: string }
  | { kind: "em"; text: string };

export type MarkdownBlock =
  | {
      kind: "code";
      language: string | null;
      code: string;
      /**
       * True when the fence was never closed.
       *
       * This is not an error case, it is the NORMAL case while a reply streams: the opening fence arrives many
       * chunks before the closing one. A parser that only recognised closed fences would show half-finished code
       * as paragraph text and then reflow it into a code block at the end, which flickers on every reply.
       */
      open: boolean;
    }
  | { kind: "heading"; level: number; spans: MarkdownSpan[] }
  | { kind: "listItem"; ordered: boolean; spans: MarkdownSpan[] }
  | { kind: "paragraph"; spans: MarkdownSpan[] };

const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([^\s`]*)/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^\s{0,3}[-*+]\s+(.*)$/;
const ORDERED = /^\s{0,3}\d{1,9}[.)]\s+(.*)$/;

/**
 * Inline spans. Deliberately single-pass and non-nesting: `**a `b`**` renders as bold plus code rather than
 * bold-containing-code. Nested emphasis is rare in assistant output and a recursive inline grammar is where
 * hand-written Markdown parsers acquire their pathological inputs.
 */
export function parseSpans(text: string): MarkdownSpan[] {
  const spans: MarkdownSpan[] = [];
  let buffer = "";
  const flush = () => {
    if (buffer !== "") spans.push({ kind: "text", text: buffer });
    buffer = "";
  };
  let index = 0;
  while (index < text.length) {
    const rest = text.slice(index);
    const code = /^`([^`]+)`/.exec(rest);
    if (code?.[1]) {
      flush();
      spans.push({ kind: "code", text: code[1] });
      index += code[0].length;
      continue;
    }
    const strong = /^(\*\*|__)(.+?)\1/.exec(rest);
    if (strong?.[2]) {
      flush();
      spans.push({ kind: "strong", text: strong[2] });
      index += strong[0].length;
      continue;
    }
    // Requires a non-space after the marker, so `a * b * c` and a bare `*` stay literal text.
    const em = /^(\*|_)(?!\s)(.+?)(?<!\s)\1/.exec(rest);
    if (em?.[2]) {
      flush();
      spans.push({ kind: "em", text: em[2] });
      index += em[0].length;
      continue;
    }
    buffer += text[index];
    index += 1;
  }
  flush();
  return spans;
}

/** Parses one reply into blocks. Safe on partial input: a reply is parsed again on every streamed chunk. */
export function parseMarkdown(text: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const lines = text.split("\n");
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const joined = paragraph.join("\n").trim();
    if (joined !== "") blocks.push({ kind: "paragraph", spans: parseSpans(joined) });
    paragraph = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string;
    const fence = FENCE.exec(line);
    if (fence) {
      flushParagraph();
      const marker = fence[1] as string;
      const language = (fence[2] ?? "").trim();
      const code: string[] = [];
      let closed = false;
      index += 1;
      for (; index < lines.length; index += 1) {
        const inner = lines[index] as string;
        // Closed only by a fence of the same character and at least the same length, as CommonMark requires --
        // otherwise a ``` inside a ````-fenced block would end it early.
        const closing = FENCE.exec(inner);
        if (closing && (closing[1] as string)[0] === marker[0] && (closing[1] as string).length >= marker.length) {
          closed = true;
          break;
        }
        code.push(inner);
      }
      blocks.push({
        kind: "code",
        language: language === "" ? null : language,
        code: code.join("\n"),
        open: !closed,
      });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading?.[1] && heading[2] !== undefined) {
      flushParagraph();
      blocks.push({ kind: "heading", level: heading[1].length, spans: parseSpans(heading[2]) });
      continue;
    }

    const bullet = BULLET.exec(line);
    if (bullet?.[1] !== undefined) {
      flushParagraph();
      blocks.push({ kind: "listItem", ordered: false, spans: parseSpans(bullet[1]) });
      continue;
    }
    const ordered = ORDERED.exec(line);
    if (ordered?.[1] !== undefined) {
      flushParagraph();
      blocks.push({ kind: "listItem", ordered: true, spans: parseSpans(ordered[1]) });
      continue;
    }

    if (line.trim() === "") flushParagraph();
    else paragraph.push(line);
  }
  flushParagraph();
  return blocks;
}
