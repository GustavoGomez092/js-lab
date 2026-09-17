// biome-ignore-all lint/suspicious/noTemplateCurlyInString: `${1:url}` in a plain string is this file's whole subject
// -- it is Monaco snippet syntax being fed to the functions under test, never an interpolation that lost its backtick.
import { describe, expect, test } from "bun:test";
import type { Snippet } from "@jslab/shared";
import {
  completionsFor,
  expansionFor,
  hasPlaceholders,
  plainInsertion,
  snippetTemplate,
  triggerWord,
} from "../src/snippets/snippet-text";

const AT = "2026-09-16T10:00:00.000Z";
const snippet = (name: string, body = "x"): Snippet => ({
  id: name,
  name,
  description: `the ${name} snippet`,
  body,
  language: null,
  createdAt: AT,
  updatedAt: AT,
});
const library = [snippet("fetchjson"), snippet("fetch"), snippet("log"), snippet("$log"), snippet("to-do")];

describe("snippet bodies (spec §13.2)", () => {
  test("a body with placeholders is a template as written", () => {
    const withStop = "const res = await fetch(${1:url});\nconst data = await res.json();\n$0";
    expect(hasPlaceholders(withStop)).toBe(true);
    expect(snippetTemplate(withStop)).toBe(withStop);
    expect(hasPlaceholders("$1")).toBe(true);
    expect(hasPlaceholders("${2:name}")).toBe(true);
  });

  test("a body without placeholders is inserted literally, with $ escaped", () => {
    expect(hasPlaceholders("const total = `${price}`")).toBe(false);
    expect(snippetTemplate("const total = `${price}`")).toBe("const total = `\\${price}`");
    expect(snippetTemplate("cost: $5 and $10")).toBe("cost: \\$5 and \\$10");
    expect(snippetTemplate("plain")).toBe("plain");
  });

  // Ruling R-M5b-D1. A bare `$<digits>` is ambiguous -- `$1` is a tab stop, `$5` is five dollars, and the text alone
  // cannot tell them apart. Both directions are pinned here because getting it wrong either way costs the same: read
  // every one as a stop and a price list corrupts; read none as a stop and tab stops stop working. The rule is where
  // the numbering starts -- a real template always carries `$1` (the first stop) or `$0` (the exit).
  test("a bare $<digits> is a tab stop only in a body that has an entry stop", () => {
    expect(hasPlaceholders("${1:name}")).toBe(true);
    expect(snippetTemplate("${1:name}")).toBe("${1:name}");
    expect(hasPlaceholders("cost: $5")).toBe(false);
    expect(snippetTemplate("cost: $5")).toBe("cost: \\$5");
    expect(hasPlaceholders("cost: $10")).toBe(false);
    expect(snippetTemplate("cost: $10")).toBe("cost: \\$10");
  });

  test("plainInsertion strips the tab stops and keeps the placeholder text", () => {
    expect(plainInsertion("await fetch(${1:url})$0")).toBe("await fetch(url)");
    expect(plainInsertion("${1}a$2b$0")).toBe("ab");
    expect(plainInsertion("no placeholders $here")).toBe("no placeholders $here");
  });

  // The other half of R-M5b-D1: here the same misreading of `$5` deletes it rather than leaving it unescaped, and
  // this is the path "Insert in New Tab" always takes (Task 9), so a price list would arrive as "cost:  and ".
  test("plainInsertion leaves a literal dollar amount alone", () => {
    expect(plainInsertion("cost: $5 and $10")).toBe("cost: $5 and $10");
    expect(plainInsertion("total: $5")).toBe("total: $5");
  });

  // Both functions read one body the same way, deliberately: once a body IS a template, every `$<digits>` in it is a
  // stop, which is the author's problem to escape rather than ours to guess at a second time.
  test("in a body that is a template, a high-numbered stop is a stop to both functions", () => {
    const body = "pay ${1:who} $5";
    expect(snippetTemplate(body)).toBe(body);
    expect(plainInsertion(body)).toBe("pay who ");
  });
});

describe("the trigger word (spec §13.3, ruling R-M5b-7)", () => {
  test("reads the name characters immediately before the caret", () => {
    expect(triggerWord("const x = fetchjson")).toBe("fetchjson");
    expect(triggerWord("  log")).toBe("log");
    expect(triggerWord("a.$log")).toBe("$log");
    expect(triggerWord("to-do")).toBe("to-do");
    expect(triggerWord("")).toBe("");
    expect(triggerWord("done ")).toBe("");
    expect(triggerWord("obj.")).toBe("");
  });
});

describe("Tab expansion (ruling R-M5b-7, channel 1)", () => {
  test("an exact trailing name expands and says how much to delete", () => {
    expect(expansionFor("const x = fetchjson", library)).toEqual({
      snippet: snippet("fetchjson"),
      deleteBefore: 9,
    });
    expect(expansionFor("FETCHJSON", library)).toEqual({ snippet: snippet("fetchjson"), deleteBefore: 9 });
  });

  test("a partial word, an unknown word, or no word at all never expands", () => {
    expect(expansionFor("fetchjs", library)).toBeNull();
    expect(expansionFor("fetchjsonx", library)).toBeNull();
    expect(expansionFor("nothing", library)).toBeNull();
    expect(expansionFor("fetchjson ", library)).toBeNull();
    expect(expansionFor("", library)).toBeNull();
    expect(expansionFor("anything", [])).toBeNull();
  });

  // `triggerWord` returns "" after a `.` or a space. Without a guard for that, the empty word would match a snippet
  // whose name is empty -- which the file schema forbids, but the `Snippet` type does not.
  test("no word before the caret never matches, even against an empty name", () => {
    expect(expansionFor("obj.", [snippet("")])).toBeNull();
    expect(expansionFor("done ", [snippet("")])).toBeNull();
  });
});

describe("the suggest widget (spec §13.3, ruling R-M5b-7, channel 2)", () => {
  test("prefix matches are offered, case-insensitively, in name order", () => {
    expect(completionsFor("fe", library).map((s) => s.name)).toEqual(["fetch", "fetchjson"]);
    expect(completionsFor("FE", library).map((s) => s.name)).toEqual(["fetch", "fetchjson"]);
  });

  test("once the full name is typed the list collapses to that one snippet (RunJS #488)", () => {
    // The point of the spec's requirement: it is still suggested. The point of R-M5b-7: it is suggested ALONE,
    // rather than continuing to rank "fetchjson" alongside it the way VS Code's fuzzy suggest would.
    expect(completionsFor("fetch", library).map((s) => s.name)).toEqual(["fetch"]);
    expect(completionsFor("FETCH", library).map((s) => s.name)).toEqual(["fetch"]);
    expect(completionsFor("fetchjson", library).map((s) => s.name)).toEqual(["fetchjson"]);
  });

  test("an empty word offers nothing, and an unmatched word offers nothing", () => {
    expect(completionsFor("", library)).toEqual([]);
    expect(completionsFor("zzz", library)).toEqual([]);
  });
});
