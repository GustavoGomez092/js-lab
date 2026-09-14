import { describe, expect, test } from "bun:test";
import { parseDotenv } from "../src/dotenv";

describe("parseDotenv (spec §5.3: JSLab parses the WD's .env itself)", () => {
  test("reads plain, exported, empty and quoted values and ignores comments", () => {
    const text = [
      "# comment",
      "",
      "A=1",
      "export B = two words  # trailing comment",
      "C=",
      'D="quoted # not a comment"',
      "E='single $HOME \\n'",
      "E= # only a comment",
      "F=#not-a-comment",
    ].join("\n");
    expect(parseDotenv(text)).toEqual({
      A: "1",
      B: "two words",
      C: "",
      D: "quoted # not a comment",
      E: "",
      F: "#not-a-comment",
    });
  });

  test("unescapes double-quoted values, which may span lines", () => {
    expect(parseDotenv('F="x\\ny"\nG="first\nsecond"\nH=after')).toEqual({ F: "x\ny", G: "first\nsecond", H: "after" });
  });

  test("skips invalid lines, tolerates CRLF, lets a later key win and never expands variables", () => {
    expect(parseDotenv("1BAD=x\r\nOK=1\r\nOK=2\r\nREF=${OK}\r\nnot a line")).toEqual({ OK: "2", REF: "${OK}" });
  });
});
