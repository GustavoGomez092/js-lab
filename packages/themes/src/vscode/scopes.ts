/** One `tokenColors` entry of a VS Code theme (spec §9.3). Every field is optional: themes in the wild omit any of them. */
export interface VsCodeTokenColor {
  scope?: string | string[];
  settings?: { foreground?: string; fontStyle?: string };
}

/** A Monaco `IStandaloneThemeData` rule. `foreground` is bare hex, as `build.ts`'s `monacoTheme` also emits. */
export interface MonacoRule {
  token: string;
  foreground?: string;
  fontStyle?: string;
}

/**
 * The scope-to-token table spec §9.3 calls for. `monacoTokenForScope` takes the LONGEST matching prefix, so the
 * order of these rows does not affect the result; they are grouped by family purely for readability. The Monaco
 * token names are the ones `build.ts`'s `monacoTheme` already emits, with one exception: `tag.function` is not in
 * that set, and reaches the palette through `syntaxColorsFrom`'s `fn` slot rather than through a Monaco rule.
 */
export const SCOPE_TO_MONACO: readonly (readonly [scope: string, token: string])[] = [
  ["punctuation.definition.comment", "comment"],
  ["comment", "comment"],

  ["constant.character.escape", "string.escape"],
  ["string.regexp", "regexp"],
  ["string", "string"],

  ["constant.numeric", "number"],
  ["constant.language", "number"],
  ["constant", "number"],

  ["keyword.operator", "delimiter"],
  ["keyword", "keyword"],
  ["storage.type", "keyword"],
  ["storage.modifier", "keyword"],
  ["storage", "keyword"],
  ["variable.language", "keyword"],

  ["entity.name.function", "tag.function"],
  ["support.function", "tag.function"],
  ["meta.function-call", "tag.function"],

  ["entity.name.type", "type"],
  ["entity.name.class", "type"],
  ["support.type", "type"],
  ["support.class", "type"],
  ["entity.other.inherited-class", "type"],

  ["entity.name.tag", "tag"],
  ["entity.other.attribute-name", "attribute.name"],

  ["punctuation", "delimiter"],
  ["meta.brace", "delimiter"],

  ["variable.parameter", "identifier"],
  ["variable", "identifier"],
];

/**
 * The longest matching scope prefix wins; an unknown scope maps to nothing rather than to a guess. A prefix only
 * matches on a whole dot-separated segment, so `commentary` is not a `comment`.
 */
export function monacoTokenForScope(scope: string): string | null {
  const trimmed = scope.trim();
  let best: { token: string; length: number } | null = null;
  for (const [prefix, token] of SCOPE_TO_MONACO) {
    const matches = trimmed === prefix || trimmed.startsWith(`${prefix}.`);
    if (matches && (best === null || prefix.length > best.length)) best = { token, length: prefix.length };
  }
  return best?.token ?? null;
}

/** VS Code allows a single scope, a comma-separated list, or an array of either. Non-string members are ignored. */
function scopeList(scope: VsCodeTokenColor["scope"]): string[] {
  if (Array.isArray(scope)) return scope.filter((entry) => typeof entry === "string").flatMap((e) => e.split(","));
  if (typeof scope === "string") return scope.split(",");
  return [];
}

/** Bare hex for Monaco, or null when the value isn't a plain `#RGB`/`#RGBA`/`#RRGGBB`/`#RRGGBBAA` colour. */
function bareHex(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const match = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value.trim());
  const digits = match?.[1];
  if (!digits) return null;
  // Monaco takes RRGGBB; 3/4-digit forms expand and any alpha channel is dropped for a token colour.
  const expanded = digits.length <= 4 ? [...digits].map((c) => c + c).join("") : digits;
  return expanded.slice(0, 6).toUpperCase();
}

/**
 * Converts `tokenColors` to Monaco rules (spec §9.3). The first entry that claims a Monaco token wins, which
 * matches how VS Code layers general scopes before specific ones. Entries with no usable scope, or with neither a
 * foreground nor a fontStyle, contribute nothing. `tokenColors` is parsed from an untrusted `.vsix`, so the
 * declared element type is a promise the JSON need not keep: a malformed entry is skipped, never thrown on.
 */
export function monacoRulesFrom(tokenColors: readonly VsCodeTokenColor[]): MonacoRule[] {
  const rules: MonacoRule[] = [];
  const claimed = new Set<string>();
  for (const raw of tokenColors) {
    const entry = raw as VsCodeTokenColor | null | undefined;
    const foreground = bareHex(entry?.settings?.foreground);
    const rawFontStyle = entry?.settings?.fontStyle;
    const fontStyle = typeof rawFontStyle === "string" ? rawFontStyle.trim() : "";
    if (foreground === null && !fontStyle) continue;
    for (const scope of scopeList(entry?.scope)) {
      const token = monacoTokenForScope(scope);
      if (token === null || claimed.has(token)) continue;
      claimed.add(token);
      rules.push({
        token,
        ...(foreground === null ? {} : { foreground }),
        ...(fontStyle ? { fontStyle } : {}),
      });
    }
  }
  return rules;
}

const SYNTAX_FROM_TOKEN = [
  ["comment", "comment"],
  ["keyword", "keyword"],
  ["string", "string"],
  ["number", "number"],
  ["type", "type"],
  ["tag.function", "fn"],
] as const;

type SyntaxKey = (typeof SYNTAX_FROM_TOKEN)[number][1];

/** The six syntax palette entries a converted theme needs, read back out of the rules (Task 3 fills the rest). */
export function syntaxColorsFrom(rules: readonly MonacoRule[]): Partial<Record<SyntaxKey, string>> {
  const byToken = new Map(rules.map((rule) => [rule.token, rule.foreground]));
  const colors: Partial<Record<SyntaxKey, string>> = {};
  for (const [token, key] of SYNTAX_FROM_TOKEN) {
    const foreground = byToken.get(token);
    if (foreground) colors[key] = `#${foreground}`;
  }
  return colors;
}
