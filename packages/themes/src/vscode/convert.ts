import { buildTheme, type ThemeDefinition } from "../build";
import { normalizeHex, paletteFromColors, themeTypeFrom } from "./derive";
import { monacoRulesFrom, syntaxColorsFrom, type VsCodeTokenColor } from "./scopes";

/**
 * A parsed VS Code colour theme (spec §9.3). Every field is optional and every declared type is a promise the JSON
 * need not keep: this is parsed straight out of an untrusted `.vsix`.
 */
export interface VsCodeThemeFile {
  name?: string;
  type?: string;
  colors?: Record<string, unknown>;
  tokenColors?: VsCodeTokenColor[];
  semanticTokenColors?: Record<string, unknown>;
  include?: string;
}

export type ConvertResult = { ok: true; theme: ThemeDefinition } | { ok: false; error: string };

const FALLBACK_ID = "imported-theme";

/** An id the Appearance picker, the palette and `commandForMenuAction`'s /^[\w-]{1,64}$/ all accept (Finding T3). */
export function slugThemeId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 64)
    // The cut can land inside a separator, so the trailing strip has to run again after it.
    .replace(/-+$/, "");
  return slug.length > 0 ? slug : FALLBACK_ID;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A VS Code colour theme → a JSLab `ThemeDefinition` (spec §9.3). Pure: no filesystem, no network, and no throw.
 * A field that is not a colour is dropped and the derived fallback stands in for it, so only a file that is not a
 * theme at all is refused — with a message shown to the user verbatim, carrying no path, stack or JSON pointer.
 *
 * `include` is deliberately not followed. Resolving it means reading a sibling file out of the archive or folder,
 * which would drag a path resolver into a pure package; a theme that relies on it still converts, using whatever it
 * defines itself plus this module's fallbacks.
 */
export function convertVsCodeTheme(input: unknown, options: { fallbackName?: string } = {}): ConvertResult {
  if (!isRecord(input)) return { ok: false, error: "That file isn't a VS Code colour theme." };
  const file = input as VsCodeThemeFile;
  if (file.colors !== undefined && !isRecord(file.colors)) {
    return { ok: false, error: "That theme's “colors” section isn't valid." };
  }
  if (file.tokenColors !== undefined && !Array.isArray(file.tokenColors)) {
    return { ok: false, error: "That theme's “tokenColors” section isn't valid." };
  }
  const colors = file.colors ?? {};
  const name = (typeof file.name === "string" && file.name.trim()) || options.fallbackName?.trim() || "Imported Theme";
  const type = themeTypeFrom(colors, file.type);
  const rules = monacoRulesFrom(file.tokenColors ?? []);

  // buildTheme fills every token, then lifts each text token to WCAG AA over every surface it is drawn on
  // (TEXT_SURFACES), on top of the surfaces paletteFromColors has already settled. That is where spec §9.1's
  // guarantee comes from for an imported theme, exactly as for the 21 built-ins.
  const theme = buildTheme({
    id: slugThemeId(name),
    name,
    type,
    credit: "Imported VS Code theme",
    palette: paletteFromColors(colors, type, syntaxColorsFrom(rules)),
  });

  // `tag.function` is the one token in the scope table that build.ts's monacoTheme never emits, so Monaco's
  // tokenizer never produces it either and a rule for it would be dead weight in every imported theme. The colour is
  // not lost — syntaxColorsFrom read it above, so it arrives as the palette's `fn` and lands on `syntax.function`.
  // Re-pointing it at `attribute.name`, which is where build.ts spends the function colour, would be worse: that is
  // the home of a theme's OWN `entity.other.attribute-name` colour, and the two would collide.
  const editorTokens = new Set(theme.monaco.rules.map((rule) => rule.token));

  // Spec §9.3: "`colors` are passed to Monaco `colors`". The theme's own values win over the derived ones, but only
  // after normalising — Monaco rejects 8-digit hex in several keys, and `editor.background` must stay opaque.
  const passthrough: Record<string, string> = {};
  for (const [key, value] of Object.entries(colors)) {
    const normalized = normalizeHex(value, theme.tokens["bg.canvas"]);
    if (normalized !== null) passthrough[key] = normalized;
  }

  return {
    ok: true,
    theme: {
      ...theme,
      monaco: {
        ...theme.monaco,
        // build.ts's rules first so a token this theme never styled keeps a readable colour underneath.
        rules: [...theme.monaco.rules, ...rules.filter((rule) => editorTokens.has(rule.token))],
        colors: { ...theme.monaco.colors, ...passthrough },
      },
    },
  };
}
