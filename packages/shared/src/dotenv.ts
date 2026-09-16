/** A WD `.env` larger than this is ignored (spec §5.3). */
export const MAX_DOTENV_BYTES = 1024 * 1024;

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;
const ESCAPES: Record<string, string> = { n: "\n", r: "\r", t: "\t", '"': '"', "\\": "\\" };
const WHITESPACE = /\s/;

/**
 * Result of scanning one segment (the quoted value's first line, or one later line freshly joined in) for
 * `quote`. `end` is the segment-relative closing index, or -1 when this segment doesn't contain it.
 * `pending` carries an unpaired trailing backslash forward: when the next segment (the next line, joined
 * with the `\n` that separated it) is scanned, passing `pending` as that scan's starting escape state
 * makes the backslash escape the joined-in newline exactly as a single full rescan of the whole value
 * would. Scanning only the newly joined segment, never the ever-growing accumulated body, keeps each
 * scan's cost proportional to that segment alone, so a value spread across many lines is scanned in time
 * linear in the value's total length instead of quadratic (accumulated-body indexing itself is cheap, but
 * repeatedly indexing into a string that is also repeatedly being concatenated onto is not).
 */
function scanQuoteSegment(segment: string, quote: string, pending: boolean): { end: number; pending: boolean } {
  let index = 0;
  let escaped = pending;
  while (index < segment.length) {
    if (escaped) {
      escaped = false;
      index++;
      continue;
    }
    const char = segment[index];
    if (char === "\\") {
      escaped = true;
      index++;
      continue;
    }
    if (char === quote) return { end: index, pending: false };
    index++;
  }
  return { end: -1, pending: escaped };
}

/**
 * Strips a trailing `# comment` in linear time: finds the first `#` preceded by at least one whitespace
 * character and cuts from the start of that whitespace run to the end of the string. A `#` with no
 * whitespace before it (`A=b#c`) is left as part of the value. Equivalent to the original
 * `value.replace(/\s+#.*$/, "")`, but without that pattern's quadratic backtracking on a long run of
 * whitespace that is never followed by `#`.
 */
function stripTrailingComment(value: string): string {
  for (let index = 0; index < value.length; index++) {
    if (value[index] !== "#") continue;
    if (index === 0 || !WHITESPACE.test(value.charAt(index - 1))) continue;
    let start = index - 1;
    while (start > 0 && WHITESPACE.test(value.charAt(start - 1))) start--;
    return value.slice(0, start);
  }
  return value;
}

/**
 * JSLab's own `.env` parser (spec §5.3; Bun's auto-load is disabled with --no-env-file). No variable expansion: a
 * value like `${HOME}` stays as written. Runs in time linear in `text.length`. A WD `.env` larger than
 * `MAX_DOTENV_BYTES` is ignored (spec §5.3): main's reader already enforces that byte cap on the file it
 * reads, so this check is a cheap lower bound (every UTF-16 code unit is at least one UTF-8 byte) that
 * guards every other caller, such as the Environment Variables sheet's paste.
 */
export function parseDotenv(text: string): Record<string, string> {
  if (text.length > MAX_DOTENV_BYTES) return {};
  const out: Record<string, string> = {};
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  for (let index = 0; index < lines.length; index++) {
    const match = LINE.exec(lines[index] ?? "");
    if (!match) continue;
    const key = match[1] as string;
    const value = match[2] ?? "";
    const raw = value.trim();
    if (raw.startsWith('"')) {
      const firstSegment = raw.slice(1);
      const parts = [firstSegment];
      let scan = scanQuoteSegment(firstSegment, '"', false);
      let offset = firstSegment.length;
      let end = scan.end;
      while (end < 0 && index + 1 < lines.length) {
        index++;
        const segment = `\n${lines[index]}`;
        parts.push(segment);
        scan = scanQuoteSegment(segment, '"', scan.pending);
        if (scan.end < 0) {
          offset += segment.length;
        } else {
          end = offset + scan.end;
        }
      }
      const body = parts.join("");
      const inner = end < 0 ? body : body.slice(0, end);
      out[key] = inner.replace(/\\([nrt"\\])/g, (_, char: string) => ESCAPES[char] ?? char);
    } else if (raw.startsWith("'")) {
      const end = raw.indexOf("'", 1);
      out[key] = end < 0 ? raw.slice(1) : raw.slice(1, end);
    } else {
      out[key] = stripTrailingComment(value).trim();
    }
  }
  return out;
}
