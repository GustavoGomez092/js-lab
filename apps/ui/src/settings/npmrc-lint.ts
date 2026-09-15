/**
 * Settings → NPM's advisory `.npmrc` lint (spec §11.5, R27-3). Save stays enabled either way: this is advisory
 * only. Warnings carry a line number and a message *kind*, never the line's own content — a line can hold an
 * auth token, and that text must never be echoed back into the UI.
 */

export type NpmrcWarningKind = "missingEquals" | "registryNotUrl";

export interface NpmrcWarning {
  line: number;
  message: NpmrcWarningKind;
}

const URL_PREFIX = /^https?:\/\//;

export function npmrcWarnings(text: string): NpmrcWarning[] {
  const warnings: NpmrcWarning[] = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = (lines[index] ?? "").trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) {
      warnings.push({ line: index + 1, message: "missingEquals" });
      continue;
    }
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    // registry / @scope:registry values that are plain URLs are fine; ${VAR} expansions are never flagged (their
    // resolved value isn't known here), and non-registry keys (auth tokens, always-auth, key[] arrays) are never
    // checked against the URL shape at all.
    if ((key === "registry" || key.endsWith(":registry")) && !value.startsWith("${") && !URL_PREFIX.test(value)) {
      warnings.push({ line: index + 1, message: "registryNotUrl" });
    }
  }
  return warnings;
}
