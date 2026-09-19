import { describe, expect, test } from "bun:test";
import {
  monacoRulesFrom,
  monacoTokenForScope,
  SCOPE_TO_MONACO,
  syntaxColorsFrom,
  type VsCodeTokenColor,
} from "../src/vscode/scopes";

describe("SCOPE_TO_MONACO", () => {
  // The four tests the plan specifies exercise only 8 of these rows; without this one, deleting any of the other
  // 20 still passes. Written as an object so row order (which longest-prefix matching ignores) is not pinned.
  test("maps exactly the scopes spec §9.3 calls for, to exactly these Monaco tokens", () => {
    expect(Object.fromEntries(SCOPE_TO_MONACO)).toEqual({
      "punctuation.definition.comment": "comment",
      comment: "comment",

      "constant.character.escape": "string.escape",
      "string.regexp": "regexp",
      string: "string",

      "constant.numeric": "number",
      "constant.language": "number",
      constant: "number",

      "keyword.operator": "delimiter",
      keyword: "keyword",
      "storage.type": "keyword",
      "storage.modifier": "keyword",
      storage: "keyword",
      "variable.language": "keyword",

      "entity.name.function": "tag.function",
      "support.function": "tag.function",
      "meta.function-call": "tag.function",

      "entity.name.type": "type",
      "entity.name.class": "type",
      "support.type": "type",
      "support.class": "type",
      "entity.other.inherited-class": "type",

      "entity.name.tag": "tag",
      "entity.other.attribute-name": "attribute.name",

      punctuation: "delimiter",
      "meta.brace": "delimiter",

      "variable.parameter": "identifier",
      variable: "identifier",
    });
    // Object.fromEntries silently collapses a duplicated scope, so pin the row count separately.
    expect(SCOPE_TO_MONACO).toHaveLength(28);
  });

  test("every row is reachable: each scope resolves to its own token, alone and as a prefix", () => {
    for (const [scope, token] of SCOPE_TO_MONACO) {
      expect(monacoTokenForScope(scope)).toBe(token);
      expect(monacoTokenForScope(`${scope}.detail.more`)).toBe(token);
    }
  });
});

describe("monacoTokenForScope", () => {
  test("matches the longest scope prefix and ignores unknown scopes", () => {
    expect(monacoTokenForScope("comment.line.double-slash.ts")).toBe("comment");
    expect(monacoTokenForScope("keyword.control.flow")).toBe("keyword");
    expect(monacoTokenForScope("string.quoted.double")).toBe("string");
    expect(monacoTokenForScope("constant.character.escape")).toBe("string.escape");
    expect(monacoTokenForScope("constant.numeric.hex")).toBe("number");
    expect(monacoTokenForScope("entity.name.type.class")).toBe("type");
    expect(monacoTokenForScope("entity.name.function.member")).toBe("tag.function");
    expect(monacoTokenForScope("entity.name.tag.html")).toBe("tag");
    expect(monacoTokenForScope("nonsense.scope.here")).toBeNull();
  });

  test("a scope that merely shares a prefix's text is not a match", () => {
    // "commentary" starts with "comment" but is a different scope; only a whole dot-separated segment counts.
    expect(monacoTokenForScope("commentary.line")).toBeNull();
    expect(monacoTokenForScope("stringify")).toBeNull();
  });

  test("an empty or whitespace-only scope matches nothing", () => {
    expect(monacoTokenForScope("")).toBeNull();
    expect(monacoTokenForScope("   ")).toBeNull();
  });
});

describe("monacoRulesFrom", () => {
  test("expands array scopes, keeps fontStyle, strips the # and drops unusable entries", () => {
    expect(
      monacoRulesFrom([
        {
          scope: ["comment", "punctuation.definition.comment"],
          settings: { foreground: "#6A9955", fontStyle: "italic" },
        },
        { scope: "keyword.control", settings: { foreground: "#C586C0" } },
        { scope: "string", settings: { fontStyle: "bold" } },
        { scope: "nonsense.scope", settings: { foreground: "#FFFFFF" } },
        { settings: { foreground: "#FFFFFF" } },
        { scope: "keyword.operator" },
      ]),
    ).toEqual([
      { token: "comment", foreground: "6A9955", fontStyle: "italic" },
      { token: "keyword", foreground: "C586C0" },
      { token: "string", fontStyle: "bold" },
    ]);
  });

  test("a comma-separated scope string is split, and the first rule for a token wins", () => {
    expect(
      monacoRulesFrom([
        { scope: "comment, string", settings: { foreground: "#111111" } },
        { scope: "comment", settings: { foreground: "#222222" } },
      ]),
    ).toEqual([
      { token: "comment", foreground: "111111" },
      { token: "string", foreground: "111111" },
    ]);
  });

  test("a comma-separated entry inside a scope array is split too", () => {
    expect(monacoRulesFrom([{ scope: ["comment, string", "keyword"], settings: { foreground: "#111111" } }])).toEqual([
      { token: "comment", foreground: "111111" },
      { token: "string", foreground: "111111" },
      { token: "keyword", foreground: "111111" },
    ]);
  });

  test("a blank or non-string fontStyle counts as absent", () => {
    expect(
      monacoRulesFrom([
        { scope: "comment", settings: { fontStyle: "   " } },
        { scope: "keyword", settings: { foreground: "#C586C0", fontStyle: "  italic  " } },
        { scope: "string", settings: { fontStyle: 7 } } as unknown as VsCodeTokenColor,
      ]),
    ).toEqual([{ token: "keyword", foreground: "C586C0", fontStyle: "italic" }]);
  });

  // A .vsix is untrusted input, and Task 3 promises conversion never throws: a malformed entry must be skipped.
  test("malformed entries are skipped instead of throwing", () => {
    const tokenColors = [
      null,
      undefined,
      42,
      "comment",
      [],
      { scope: ["keyword", 42, null], settings: { foreground: "#C586C0" } },
      { scope: 99, settings: { foreground: "#FFFFFF" } },
      { scope: "comment", settings: { foreground: "#6A9955" } },
    ] as unknown as VsCodeTokenColor[];
    expect(monacoRulesFrom(tokenColors)).toEqual([
      { token: "keyword", foreground: "C586C0" },
      { token: "comment", foreground: "6A9955" },
    ]);
  });
});

describe("colour parsing", () => {
  test("3- and 4-digit hex expand, 8-digit drops its alpha, and the result is upper-case", () => {
    expect(
      monacoRulesFrom([
        { scope: "comment", settings: { foreground: "#abc" } },
        { scope: "keyword", settings: { foreground: "#1234" } },
        { scope: "string", settings: { foreground: "#11223344" } },
        { scope: "constant.numeric", settings: { foreground: "#6a9955" } },
      ]),
    ).toEqual([
      { token: "comment", foreground: "AABBCC" },
      { token: "keyword", foreground: "112233" },
      { token: "string", foreground: "112233" },
      { token: "number", foreground: "6A9955" },
    ]);
  });

  test("surrounding whitespace in a colour is tolerated", () => {
    expect(monacoRulesFrom([{ scope: "comment", settings: { foreground: "  #6A9955  " } }])).toEqual([
      { token: "comment", foreground: "6A9955" },
    ]);
  });

  test("anything that is not a plain hex colour is refused", () => {
    expect(
      monacoRulesFrom([
        { scope: "comment", settings: { foreground: "#12345" } },
        { scope: "keyword", settings: { foreground: "#GGGGGG" } },
        { scope: "string", settings: { foreground: "rgb(1, 2, 3)" } },
        { scope: "constant.numeric", settings: { foreground: "red" } },
        { scope: "storage", settings: { foreground: "#abcdef extra" } },
        { scope: "variable", settings: { foreground: 16777215 } } as unknown as VsCodeTokenColor,
      ]),
    ).toEqual([]);
  });
});

describe("syntaxColorsFrom", () => {
  test("reads the six syntax palette entries back out, with # restored", () => {
    const rules = monacoRulesFrom([
      { scope: "comment", settings: { foreground: "#6A9955" } },
      { scope: "keyword", settings: { foreground: "#C586C0" } },
      { scope: "string", settings: { foreground: "#CE9178" } },
      { scope: "constant.numeric", settings: { foreground: "#B5CEA8" } },
      { scope: "entity.name.type", settings: { foreground: "#4EC9B0" } },
      { scope: "entity.name.function", settings: { foreground: "#DCDCAA" } },
    ]);
    expect(syntaxColorsFrom(rules)).toEqual({
      comment: "#6A9955",
      keyword: "#C586C0",
      string: "#CE9178",
      number: "#B5CEA8",
      type: "#4EC9B0",
      fn: "#DCDCAA",
    });
  });

  test("returns only what the theme actually defined", () => {
    expect(syntaxColorsFrom(monacoRulesFrom([{ scope: "comment", settings: { foreground: "#6A9955" } }]))).toEqual({
      comment: "#6A9955",
    });
  });

  test("a rule carrying only a fontStyle contributes no colour", () => {
    expect(syntaxColorsFrom([{ token: "comment", fontStyle: "italic" }])).toEqual({});
  });

  test("Monaco tokens outside the six syntax slots are ignored", () => {
    expect(
      syntaxColorsFrom([
        { token: "delimiter", foreground: "AAAAAA" },
        { token: "tag", foreground: "BBBBBB" },
        { token: "attribute.name", foreground: "CCCCCC" },
        { token: "regexp", foreground: "DDDDDD" },
        { token: "string.escape", foreground: "EEEEEE" },
        { token: "identifier", foreground: "FFFFFF" },
      ]),
    ).toEqual({});
  });
});
