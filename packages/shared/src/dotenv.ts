/** A WD `.env` larger than this is ignored (spec §5.3). */
export const MAX_DOTENV_BYTES = 1024 * 1024;

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;
const ESCAPES: Record<string, string> = { n: "\n", r: "\r", t: "\t", '"': '"', "\\": "\\" };

function closingQuote(text: string, quote: string): number {
  for (let index = 0; index < text.length; index++) {
    if (text[index] === "\\") {
      index++;
      continue;
    }
    if (text[index] === quote) return index;
  }
  return -1;
}

/**
 * JSLab's own `.env` parser (spec §5.3; Bun's auto-load is disabled with --no-env-file). No variable expansion: a
 * value like `${HOME}` stays as written.
 */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  for (let index = 0; index < lines.length; index++) {
    const match = LINE.exec(lines[index] ?? "");
    if (!match) continue;
    const key = match[1] as string;
    const value = match[2] ?? "";
    const raw = value.trim();
    if (raw.startsWith('"')) {
      let body = raw.slice(1);
      while (closingQuote(body, '"') < 0 && index + 1 < lines.length) {
        index++;
        body += `\n${lines[index]}`;
      }
      const end = closingQuote(body, '"');
      const inner = end < 0 ? body : body.slice(0, end);
      out[key] = inner.replace(/\\([nrt"\\])/g, (_, char: string) => ESCAPES[char] ?? char);
    } else if (raw.startsWith("'")) {
      const end = raw.indexOf("'", 1);
      out[key] = end < 0 ? raw.slice(1) : raw.slice(1, end);
    } else {
      out[key] = value.replace(/\s+#.*$/, "").trim();
    }
  }
  return out;
}
