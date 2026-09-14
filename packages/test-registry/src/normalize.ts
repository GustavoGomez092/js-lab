import { stripAnsi } from "@jslab/npm";

/** Makes captured tool output safe to commit and stable across runs (privacy rule; R-M3-PLAN-1 (f)). */
export function normalizeOutput(text: string, replacements: readonly [string, string][]): string {
  let out = stripAnsi(text);
  for (const [from, to] of replacements) if (from) out = out.split(from).join(to);
  return out.replace(/\[\d+(?:\.\d+)?m?s\]/g, "[<ms>]").replace(/\(([0-9a-f]{7,40})\)/g, "(<rev>)");
}
