import { describe, expect, test } from "bun:test";
import {
  isValidSnippetName,
  MAX_SNIPPET_BODY_CHARS,
  MAX_SNIPPETS,
  mergeSnippets,
  newSnippet,
  parseSnippetsFile,
  SNIPPETS_FORMAT,
  SNIPPETS_VERSION,
  type Snippet,
  snippetsFileContent,
  uniqueSnippetName,
} from "../src/snippets";

const AT = "2026-09-16T10:00:00.000Z";
const record = (overrides: Partial<Snippet> = {}): Snippet => ({
  id: "s1",
  name: "fetchjson",
  description: "Fetch + parse JSON",
  body: "const res = await fetch(${1:url});\n$0",
  language: "typescript",
  createdAt: AT,
  updatedAt: AT,
  ...overrides,
});
const file = (snippets: Snippet[], version = SNIPPETS_VERSION) => ({
  format: SNIPPETS_FORMAT,
  version,
  snippets,
});

describe("snippet names (spec §13.1)", () => {
  test("accepts the documented pattern and rejects everything else", () => {
    for (const name of ["fetchjson", "fetch_json", "fetch-json", "$log", "A1"]) {
      expect(isValidSnippetName(name)).toBe(true);
    }
    for (const name of ["", "fetch json", "fetch.json", "fetch/json", "a".repeat(101), "héllo"]) {
      expect(isValidSnippetName(name)).toBe(false);
    }
  });

  test("newSnippet fills the timestamps and trims the description", () => {
    const created = newSnippet(
      { name: "log", description: "  says hi  ", body: "console.log($0)" },
      () => AT,
      () => "generated",
    );
    expect(created).toEqual({
      id: "generated",
      name: "log",
      description: "says hi",
      body: "console.log($0)",
      language: null,
      createdAt: AT,
      updatedAt: AT,
    });
  });
});

describe("the jslab-snippets file (spec §13.4)", () => {
  test("round-trips a valid library", () => {
    const parsed = parseSnippetsFile(JSON.parse(snippetsFileContent([record()])));
    expect(parsed).toEqual({ ok: true, snippets: [record()] });
  });

  test("refuses every malformed shape with a reason, and never throws", () => {
    const cases: [unknown, string][] = [
      [null, "notObject"],
      ["jslab-snippets", "notObject"],
      [[record()], "notObject"],
      [{ format: "vscode-snippets", version: 1, snippets: [] }, "wrongFormat"],
      [{ version: 1, snippets: [] }, "wrongFormat"],
      [file([], SNIPPETS_VERSION + 1), "newerVersion"],
      [{ format: SNIPPETS_FORMAT, version: 1, snippets: "all of them" }, "invalidSnippets"],
      [file([record({ name: "no spaces allowed" })]), "invalidSnippets"],
      [file([record({ body: "x".repeat(MAX_SNIPPET_BODY_CHARS + 1) })]), "invalidSnippets"],
      [file([record({ createdAt: "whenever" })]), "invalidSnippets"],
      [file([record({ language: "cobol" as never })]), "invalidSnippets"],
      [file([record(), record({ id: "s2" })]), "duplicateNames"],
      [file([record(), record({ name: "other" })]), "duplicateIds"],
    ];
    for (const [input, reason] of cases) {
      const result = parseSnippetsFile(input);
      expect([input, result.ok]).toEqual([input, false]);
      if (result.ok) continue;
      expect([input, result.reason]).toEqual([input, reason as never]);
      expect(result.detail.length).toBeGreaterThan(0);
    }
  });

  test("a name differing only in case is still a duplicate, and the cap is enforced", () => {
    const shouted = parseSnippetsFile(file([record(), record({ id: "s2", name: "FETCHJSON" })]));
    expect(shouted.ok ? "accepted" : shouted.reason).toBe("duplicateNames");
    const tooMany = Array.from({ length: MAX_SNIPPETS + 1 }, (_, index) =>
      record({ id: `s${index}`, name: `s${index}` }),
    );
    const capped = parseSnippetsFile(file(tooMany));
    expect(capped.ok ? "accepted" : capped.reason).toBe("invalidSnippets");
  });

  test("unknown keys on a record are dropped rather than rejected", () => {
    const withExtra = { ...record(), shortcut: "cmd+j" } as unknown as Snippet;
    const parsed = parseSnippetsFile(file([withExtra]));
    expect(parsed.ok && parsed.snippets[0]).toEqual(record());
  });
});

describe("merging an imported library (spec §13.1 Options menu)", () => {
  const existing = [record({ id: "e1", name: "fetchjson", body: "OLD" })];
  const incoming = [
    record({ id: "i1", name: "FetchJson", body: "NEW" }),
    record({ id: "i2", name: "brandnew", body: "FRESH" }),
  ];
  let counter = 0;
  const newId = () => `new${++counter}`;

  test("overwrite keeps the existing id and takes the incoming content", () => {
    counter = 0;
    const merged = mergeSnippets(existing, incoming, "overwrite", newId);
    expect([merged.added, merged.overwritten, merged.skipped, merged.renamed]).toEqual([1, 1, 0, 0]);
    expect(merged.snippets.map((s) => [s.id, s.name, s.body])).toEqual([
      ["e1", "FetchJson", "NEW"],
      ["new1", "brandnew", "FRESH"],
    ]);
  });

  test("skip leaves the conflicting record untouched", () => {
    counter = 0;
    const merged = mergeSnippets(existing, incoming, "skip", newId);
    expect([merged.added, merged.overwritten, merged.skipped, merged.renamed]).toEqual([1, 0, 1, 0]);
    expect(merged.snippets.map((s) => [s.id, s.name, s.body])).toEqual([
      ["e1", "fetchjson", "OLD"],
      ["new1", "brandnew", "FRESH"],
    ]);
  });

  test("keepBoth renames the incoming copy to a free, still-valid name", () => {
    counter = 0;
    const merged = mergeSnippets(existing, incoming, "keepBoth", newId);
    expect([merged.added, merged.overwritten, merged.skipped, merged.renamed]).toEqual([2, 0, 0, 1]);
    expect(merged.snippets.map((s) => [s.id, s.name])).toEqual([
      ["e1", "fetchjson"],
      ["new1", "FetchJson-2"],
      ["new2", "brandnew"],
    ]);
    expect(isValidSnippetName("FetchJson-2")).toBe(true);
  });

  test("uniqueSnippetName keeps counting past an existing -2", () => {
    const taken = [record({ id: "a", name: "log" }), record({ id: "b", name: "log-2" })];
    expect(uniqueSnippetName(taken, "log")).toBe("log-3");
    expect(uniqueSnippetName(taken, "free")).toBe("free");
  });

  test("an import can never exceed the cap", () => {
    const full = Array.from({ length: MAX_SNIPPETS }, (_, i) => record({ id: `f${i}`, name: `f${i}` }));
    const merged = mergeSnippets(full, [record({ id: "x", name: "overflow" })], "keepBoth", newId);
    expect(merged.snippets).toHaveLength(MAX_SNIPPETS);
    expect(merged.added).toBe(0);
  });
});
