import { describe, expect, test } from "bun:test";
import type { Snippet } from "@jslab/shared";
import { filterSnippets, type RankedSnippet } from "../src/snippets/snippet-filter";

const AT = "2026-09-16T10:00:00.000Z";
const snippet = (name: string, description = ""): Snippet => ({
  id: name,
  name,
  description,
  body: "x",
  language: null,
  createdAt: AT,
  updatedAt: AT,
});

const FETCHJSON = snippet("fetchjson", "Fetch + parse JSON");
const LOG = snippet("log", "print a value");
const LIBRARY = [LOG, FETCHJSON, snippet("arrow", "an arrow function")];
const names = (library: readonly Snippet[], query: string) =>
  filterSnippets(library, query).map((ranked) => ranked.snippet.name);

describe("snippet search (spec §13.1)", () => {
  test("an empty query lists everything in name order", () => {
    expect(names(LIBRARY, "")).toEqual(["arrow", "fetchjson", "log"]);
    expect(names(LIBRARY, "   ")).toEqual(["arrow", "fetchjson", "log"]);
  });

  test("the query matches the name and the description", () => {
    expect(names(LIBRARY, "fetch")).toEqual(["fetchjson"]);
    expect(names(LIBRARY, "JSON")).toEqual(["fetchjson"]);
    expect(names(LIBRARY, "function")).toEqual(["arrow"]);
    expect(names(LIBRARY, "print a value")).toEqual(["log"]);
  });

  test("a name match outranks a description-only match, however weak the name match is", () => {
    // The description-only match is listed first, so library order alone would get this wrong.
    const both = [snippet("other", "uses the helper"), snippet("helper", "nothing relevant")];
    expect(names(both, "helper")).toEqual(["helper", "other"]);
    // Here the raw scores disagree with the answer: "abc" hits "axbxc" only as a scattered subsequence
    // (matchTitle scores that 10) but hits the other snippet's description as a prefix (scored 300).
    const weakName = [snippet("zzz", "abc list"), snippet("axbxc", "")];
    expect(names(weakName, "abc")).toEqual(["axbxc", "zzz"]);
  });

  test("among name matches the better match wins, even when the alphabet disagrees", () => {
    const both = [snippet("alog"), snippet("log")];
    expect(names(both, "log")).toEqual(["log", "alog"]);
  });

  test("among description-only matches the better match wins too", () => {
    const both = [snippet("aaa", "an arrow function"), snippet("zzz", "arrow helper")];
    expect(names(both, "arrow")).toEqual(["zzz", "aaa"]);
  });

  test("equally scored matches break the tie by name, not by library order", () => {
    const tied = [snippet("zed", "even"), snippet("abe", "even")];
    expect(names(tied, "even")).toEqual(["abe", "zed"]);
  });

  test("a ranked entry carries the ranges of whichever field matched, and nothing else", () => {
    // R-M5b-DESC-1: the panel highlights why a row matched, so a description-only match must carry its ranges too --
    // otherwise a row matched on text the user cannot see shows no indication of why it is there.
    // "fetch" hits this snippet's name AND its description ("Fetch + parse JSON"), and only the name is ranged:
    // the name is why it ranked, and highlighting both would claim the description decided something it did not.
    const expected: RankedSnippet[] = [{ snippet: FETCHJSON, nameRanges: [[0, 5]], descriptionRanges: [] }];
    expect(filterSnippets(LIBRARY, "fetch")).toEqual(expected);
    // The mirror image: the name misses entirely, so the description's ranges are the only ones there are.
    expect(filterSnippets(LIBRARY, "print")).toEqual([{ snippet: LOG, nameRanges: [], descriptionRanges: [[0, 5]] }]);
  });

  test("a description match's ranges point into the description, not back at the name", () => {
    // Offset 8 of "print a value", not 0 -- a range hardcoded to the start of the string would highlight "print".
    expect(filterSnippets(LIBRARY, "value")).toEqual([{ snippet: LOG, nameRanges: [], descriptionRanges: [[8, 13]] }]);
  });

  test("an unmatched query returns nothing, and an empty library returns nothing", () => {
    expect(names(LIBRARY, "zzzz")).toEqual([]);
    expect(filterSnippets([], "anything")).toEqual([]);
    expect(filterSnippets([], "")).toEqual([]);
  });

  test("500 snippets filter in one pass, and nothing caps the result", () => {
    const many = Array.from({ length: 500 }, (_, index) =>
      snippet(`snip${String(index).padStart(3, "0")}`, index % 2 === 0 ? "even" : "odd"),
    );
    expect(filterSnippets(many, "")).toHaveLength(500);
    // The palette's own buildSections caps a query at 60 rows; this panel virtualizes instead, so it must not.
    expect(filterSnippets(many, "even")).toHaveLength(250);
    expect(names(many, "snip499")).toEqual(["snip499"]);
  });
});
