export const TOKEN_NAMES = [
  "bg.canvas",
  "bg.chrome",
  "bg.elevated",
  "bg.hover",
  "bg.selection",
  "bg.activeRow",
  "bg.errorRow",
  "bg.errorRowHover",
  "bg.lineHover",
  "bg.lineHighlight",
  "bg.accentMuted",
  "bg.scrim",
  "border.default",
  "border.muted",
  "border.accent",
  "fg.default",
  "fg.muted",
  "fg.accent",
  "fg.onAccent",
  "fg.success",
  "fg.warn",
  "fg.error",
  "fg.info",
  "console.result",
  "console.log",
  "console.info",
  "console.warn",
  "console.error",
  "syntax.comment",
  "syntax.keyword",
  "syntax.string",
  "syntax.number",
  "syntax.type",
  "syntax.function",
] as const;

export type TokenName = (typeof TOKEN_NAMES)[number];
export type ThemeTokens = Record<TokenName, string>;

const SURFACES: TokenName[] = ["bg.canvas", "bg.chrome", "bg.elevated"];
// Output values render with syntax colors on hovered rows (Task 19), so code colors must pass on bg.lineHover too.
const CODE_SURFACES: TokenName[] = ["bg.canvas", "bg.elevated", "bg.lineHover"];

/** The surfaces each text token is drawn on. Every pair must meet WCAG AA. */
export const TEXT_SURFACES: Partial<Record<TokenName, TokenName[]>> = {
  "fg.default": [...SURFACES, "bg.hover", "bg.selection", "bg.activeRow", "bg.errorRow", "bg.lineHover"],
  // Muted text sits on hovered buttons and chips (bg.hover) and inside error rows, hovered or not (review I8, FB-m7:
  // stack frames and the internal-frames count). Line anchors turn accent on hovered rows, so muted text isn't drawn
  // on bg.lineHover.
  "fg.muted": [...SURFACES, "bg.hover", "bg.errorRow", "bg.errorRowHover"],
  // The palette highlights matches in the accent color on the active row (Task 20); output line anchors turn
  // accent on hovered rows (Task 19), error rows included (FB-m7).
  "fg.accent": [...SURFACES, "bg.activeRow", "bg.lineHover", "bg.errorRowHover"],
  "fg.success": SURFACES,
  // Warn and info output rows keep their text color while hovered (FB-m7).
  "fg.warn": [...SURFACES, "bg.lineHover"],
  "fg.info": [...SURFACES, "bg.lineHover"],
  "fg.error": [...SURFACES, "bg.errorRow", "bg.errorRowHover"],
  "fg.onAccent": ["bg.accentMuted"],
  "syntax.comment": CODE_SURFACES,
  "syntax.keyword": CODE_SURFACES,
  "syntax.string": CODE_SURFACES,
  "syntax.number": CODE_SURFACES,
  "syntax.type": CODE_SURFACES,
  "syntax.function": CODE_SURFACES,
};

export const CONTRAST_PAIRS: [TokenName, TokenName][] = (
  Object.entries(TEXT_SURFACES) as [TokenName, TokenName[]][]
).flatMap(([fg, backgrounds]) => backgrounds.map((bg): [TokenName, TokenName] => [fg, bg]));

export function cssVariableName(token: TokenName): string {
  return `--${token.replace(".", "-")}`;
}

export function toCssVariables(tokens: ThemeTokens): Record<string, string> {
  return Object.fromEntries(TOKEN_NAMES.map((name) => [cssVariableName(name), tokens[name]]));
}
