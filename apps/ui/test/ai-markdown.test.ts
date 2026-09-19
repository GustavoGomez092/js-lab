import { describe, expect, test } from "bun:test";
import { parseMarkdown, parseSpans } from "../src/ai/markdown";

describe("assistant Markdown (spec §14.1)", () => {
  test("a fenced block keeps its language and its exact text", () => {
    const blocks = parseMarkdown("Here:\n```ts\nconst a = 1;\n```\ndone");
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toEqual({ kind: "paragraph", spans: [{ kind: "text", text: "Here:" }] });
    expect(blocks[1]).toEqual({ kind: "code", language: "ts", code: "const a = 1;", open: false });
    expect(blocks[2]?.kind).toBe("paragraph");
  });

  /**
   * The streaming case, and the reason `open` exists: while a reply streams, the opening fence arrives many
   * chunks before the closing one. Treating an unclosed fence as prose would show half-written code as a
   * paragraph and then reflow it into a code block at the end, flickering on every reply.
   */
  test("an unclosed fence is still a code block, marked open", () => {
    const blocks = parseMarkdown("```js\nconst partial = (");
    expect(blocks).toEqual([{ kind: "code", language: "js", code: "const partial = (", open: true }]);
  });

  test("a fence with no language has a null language rather than an empty string", () => {
    expect(parseMarkdown("```\nplain\n```")[0]).toEqual({ kind: "code", language: null, code: "plain", open: false });
  });

  /** CommonMark: a longer fence is not closed by a shorter one, or a ``` inside a ````-block ends it early. */
  test("a shorter inner fence does not close a longer outer one", () => {
    const blocks = parseMarkdown("````md\n```ts\nnested\n```\n````");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: "code", language: "md", open: false });
    expect((blocks[0] as { code: string }).code).toBe("```ts\nnested\n```");
  });

  test("headings, bullets and numbered items are their own blocks", () => {
    const blocks = parseMarkdown("## Title\n- one\n2. two\nprose");
    expect(blocks[0]).toMatchObject({ kind: "heading", level: 2 });
    expect(blocks[1]).toMatchObject({ kind: "listItem", ordered: false });
    expect(blocks[2]).toMatchObject({ kind: "listItem", ordered: true });
    expect(blocks[3]?.kind).toBe("paragraph");
  });

  test("inline code, bold and italic become spans; a lone asterisk stays text", () => {
    expect(parseSpans("use `x` now")).toEqual([
      { kind: "text", text: "use " },
      { kind: "code", text: "x" },
      { kind: "text", text: " now" },
    ]);
    expect(parseSpans("**bold**")).toEqual([{ kind: "strong", text: "bold" }]);
    expect(parseSpans("_soft_")).toEqual([{ kind: "em", text: "soft" }]);
    // A multiplication in prose must not silently become emphasis.
    expect(parseSpans("a * b * c")).toEqual([{ kind: "text", text: "a * b * c" }]);
  });

  /**
   * The security property this module exists for: the parser yields DATA, never markup. Nothing in a reply can
   * become an element, so there is no path from model output to script in the main window.
   */
  test("HTML in a reply stays literal text rather than becoming markup", () => {
    const blocks = parseMarkdown("<img src=x onerror=alert(1)>");
    expect(blocks).toEqual([{ kind: "paragraph", spans: [{ kind: "text", text: "<img src=x onerror=alert(1)>" }] }]);
    const fenced = parseMarkdown("```html\n<script>alert(1)</script>\n```");
    expect(fenced[0]).toMatchObject({ kind: "code", code: "<script>alert(1)</script>" });
  });

  test("an empty reply parses to no blocks at all", () => {
    expect(parseMarkdown("")).toEqual([]);
    expect(parseMarkdown("\n\n")).toEqual([]);
  });
});
