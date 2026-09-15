import { describe, expect, test } from "bun:test";
import { MAX_DOTENV_BYTES, parseDotenv } from "../src/dotenv";

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

// Frozen copy of parseDotenv (and its closingQuote helper) exactly as it stood before R-M3-DOTENV-1, kept
// here only so the rewritten linear-time parser can be proven to return identical results. Never change
// this copy to make a test pass: if it and the real parser disagree, the real parser is wrong.
const LEGACY_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;
const LEGACY_ESCAPES: Record<string, string> = { n: "\n", r: "\r", t: "\t", '"': '"', "\\": "\\" };

function legacyClosingQuote(text: string, quote: string): number {
  for (let index = 0; index < text.length; index++) {
    if (text[index] === "\\") {
      index++;
      continue;
    }
    if (text[index] === quote) return index;
  }
  return -1;
}

function legacyParseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  for (let index = 0; index < lines.length; index++) {
    const match = LEGACY_LINE.exec(lines[index] ?? "");
    if (!match) continue;
    const key = match[1] as string;
    const value = match[2] ?? "";
    const raw = value.trim();
    if (raw.startsWith('"')) {
      let body = raw.slice(1);
      while (legacyClosingQuote(body, '"') < 0 && index + 1 < lines.length) {
        index++;
        body += `\n${lines[index]}`;
      }
      const end = legacyClosingQuote(body, '"');
      const inner = end < 0 ? body : body.slice(0, end);
      out[key] = inner.replace(/\\([nrt"\\])/g, (_, char: string) => LEGACY_ESCAPES[char] ?? char);
    } else if (raw.startsWith("'")) {
      const end = raw.indexOf("'", 1);
      out[key] = end < 0 ? raw.slice(1) : raw.slice(1, end);
    } else {
      out[key] = value.replace(/\s+#.*$/, "").trim();
    }
  }
  return out;
}

describe("parseDotenv vs the pre-R-M3-DOTENV-1 parser (equivalence, timing and the size cap)", () => {
  // Build every character that needs escaping via String.fromCharCode, never as a typed backslash escape.
  const NL = String.fromCharCode(10);
  const CR = String.fromCharCode(13);
  const BS = String.fromCharCode(92);
  const TAB = String.fromCharCode(9);
  const Q = '"';

  const corpus: string[] = [
    // An escaped quote inside a quoted value: the value's real terminator is the final unescaped quote.
    "A=" + Q + "say " + BS + Q + "hi" + BS + Q + Q,
    // A backslash as the last character of a line inside an open quote: it must swallow the joined newline.
    "A=" + Q + "ab" + BS + NL + "cd" + Q,
    // A quote that only closes on the third line.
    "A=" + Q + "one" + NL + "two" + NL + "three" + Q,
    // An unclosed quote at EOF.
    "A=" + Q + "unterminated",
    // export lines, with extra whitespace around the key and value.
    "export FOO=bar" + NL + "  export   BAR = baz  ",
    // CRLF line endings.
    "A=1" + CR + NL + "B=2",
    // A lone CR (no following LF).
    "A=1" + CR + "B=2",
    // A `#` with no preceding whitespace stays part of the value.
    "A=b#c",
    // A `#` preceded by whitespace starts a trailing comment.
    "A=b #c",
    // A value that is entirely a trailing comment.
    "A=   #only-comment",
    // A single-quoted value that closes.
    "A='hello world'",
    // A single-quoted value that never closes.
    "A='hello world",
    // An empty value.
    "A=",
    // A duplicate key: the later assignment wins.
    "A=1" + NL + "A=2",
    // An invalid key on its own line is skipped; a valid line after it still parses.
    "1BAD=x" + NL + "OK=1",
    // `${VAR}` is left unexpanded.
    "A=${HOME}/foo",
    // A quoted value followed by trailing text after its closing quote: the trailing text is dropped.
    "A=" + Q + "hello" + Q + " extra text here",
    // Tabs before a `#` still start a trailing comment.
    "A=x" + TAB + "#comment",
    // A combined case: export, a backslash-continued quoted value, a trailing comment, a single-quoted
    // value, an invalid line and an unclosed quote, all in one file.
    "export A=" +
      Q +
      "line1" +
      BS +
      NL +
      "line2" +
      Q +
      NL +
      "B=b " +
      TAB +
      "#trail" +
      NL +
      "C='single'" +
      NL +
      "1INVALID=z" +
      NL +
      "D=" +
      Q +
      "no close",
    // A combined case: CRLF, a duplicate key, and a quoted value with tabs before its trailing comment.
    "A=1" + CR + NL + "A=" + Q + "final" + Q + NL + "export B = value with " + TAB + "#note",
  ];

  test("matches the previous parser on tricky inputs", () => {
    for (const input of corpus) {
      expect(parseDotenv(input)).toEqual(legacyParseDotenv(input));
    }
  });

  test("stays linear on an unclosed quote and on long whitespace", () => {
    // ~400 KB: an opening quote that never closes, spread across 200,000 lines.
    const unclosedBody = ("x" + NL).repeat(200_000);
    const unclosedInput = "A=" + Q + unclosedBody;
    const startUnclosed = performance.now();
    const unclosedResult = parseDotenv(unclosedInput);
    const elapsedUnclosed = performance.now() - startUnclosed;
    expect(elapsedUnclosed).toBeLessThan(500);
    // The legacy parser is too slow on this input to call directly; the expected value is the whole
    // unclosed body (the quote never closes, so `inner` is the accumulated body as-is).
    expect(unclosedResult).toEqual({ A: unclosedBody });

    // 500,000 spaces with no `#` anywhere: the old regex backtracks quadratically here.
    const longWhitespaceInput = "B=" + " ".repeat(500_000) + "x";
    const startWhitespace = performance.now();
    const whitespaceResult = parseDotenv(longWhitespaceInput);
    const elapsedWhitespace = performance.now() - startWhitespace;
    expect(elapsedWhitespace).toBeLessThan(500);
    expect(whitespaceResult).toEqual({ B: "x" });
  });

  test("ignores text larger than MAX_DOTENV_BYTES", () => {
    const oversized = "A=1" + NL + "x".repeat(MAX_DOTENV_BYTES);
    const start = performance.now();
    const result = parseDotenv(oversized);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(500);
    expect(result).toEqual({});
  });
});
