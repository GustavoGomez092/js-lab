export type Redactor = (text: string) => string;

export const REDACTED = "[REDACTED]";

// Value classes stop at whitespace, quotes, `,`, `}` and `]` (never `\S+`/greedy) so a match can never swallow
// JSON/quote delimiters around it -- required even though buildDebugReport now redacts free text before
// JSON.stringify (I-1), since createRedactor is also used on already-serialized log lines.
const PATTERNS: [RegExp, string][] = [
  [/(authorization["']?\s*[:=]\s*\[?\s*["']?)(?:(?:bearer|basic|token)\s+)?[^\s"',}\]]+/gi, `$1${REDACTED}`],
  [/(_authToken\s*=\s*)[^\s"',}\]]+/g, `$1${REDACTED}`],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, REDACTED],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, REDACTED],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, REDACTED],
];

/** Log and debug-report redaction (spec §18). `secrets` supplies exact values, such as env.json values (M3). */
export function createRedactor(secrets: () => readonly string[] = () => []): Redactor {
  return (text) => {
    let out = text;
    for (const secret of secrets()) if (secret.length >= 4) out = out.split(secret).join(REDACTED);
    for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
    return out;
  };
}
