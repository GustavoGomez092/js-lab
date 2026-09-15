import { ensureContrast, hexToRgb, mix, rgbToHex } from "./contrast";
import { TEXT_SURFACES, type ThemeTokens, type TokenName } from "./tokens";

export interface Palette {
  canvas: string;
  chrome: string;
  elevated: string;
  border: string;
  fg: string;
  muted: string;
  accent: string;
  error: string;
  warn: string;
  success: string;
  info: string;
  string: string;
  number: string;
  keyword: string;
  fn: string;
  type: string;
  comment: string;
  selection: string;
  lineHighlight: string;
}

export interface ThemeInput {
  id: string;
  name: string;
  type: "dark" | "light";
  /** Palette source and license, shown in About → Credits (M6). */
  credit: string;
  palette: Palette;
  overrides?: Partial<ThemeTokens>;
}

export interface MonacoThemeData {
  base: "vs" | "vs-dark";
  inherit: true;
  rules: { token: string; foreground?: string; fontStyle?: string }[];
  colors: Record<string, string>;
}

export interface ThemeDefinition {
  id: string;
  name: string;
  type: "dark" | "light";
  credit: string;
  tokens: ThemeTokens;
  monaco: MonacoThemeData;
}

const normalize = (hex: string) => rgbToHex(hexToRgb(hex));

export function buildTheme(input: ThemeInput): ThemeDefinition {
  const p = input.palette;
  const dark = input.type === "dark";
  const tokens: ThemeTokens = {
    "bg.canvas": p.canvas,
    "bg.chrome": p.chrome,
    "bg.elevated": p.elevated,
    "bg.hover": mix(p.elevated, p.fg, 0.06),
    "bg.selection": p.selection,
    "bg.activeRow": mix(p.elevated, p.accent, 0.18),
    "bg.errorRow": mix(p.canvas, p.error, dark ? 0.1 : 0.08),
    "bg.lineHover": mix(p.canvas, p.accent, dark ? 0.16 : 0.12),
    "bg.lineHighlight": p.lineHighlight,
    "bg.accentMuted": mix(p.canvas, p.accent, dark ? 0.28 : 0.16),
    "bg.scrim": dark ? "#0A0C0F" : "#14171C",
    "border.default": p.border,
    "border.muted": mix(p.canvas, p.border, 0.6),
    "border.accent": p.accent,
    "fg.default": p.fg,
    "fg.muted": p.muted,
    "fg.accent": p.accent,
    "fg.onAccent": dark ? mix(p.fg, "#FFFFFF", 0.5) : mix(p.fg, "#000000", 0.3),
    "fg.success": p.success,
    "fg.warn": p.warn,
    "fg.error": p.error,
    "fg.info": p.info,
    "console.result": p.accent,
    "console.log": mix(p.muted, p.fg, 0.2),
    "console.info": p.info,
    "console.warn": p.warn,
    "console.error": p.error,
    "syntax.comment": p.comment,
    "syntax.keyword": p.keyword,
    "syntax.string": p.string,
    "syntax.number": p.number,
    "syntax.type": p.type,
    "syntax.function": p.fn,
    // Derived below from the final error-row and line-hover colors, so overrides of either carry through.
    "bg.errorRowHover": "",
    ...input.overrides,
  };
  // FB-m7: a hovered error row was a CSS color-mix (40% line hover over the error tint). As a token it's a real surface
  // the contrast pass below covers.
  if (!input.overrides?.["bg.errorRowHover"]) {
    tokens["bg.errorRowHover"] = mix(tokens["bg.errorRow"], tokens["bg.lineHover"], 0.4);
  }
  for (const name of Object.keys(tokens) as TokenName[]) tokens[name] = normalize(tokens[name]);
  for (const [fg, surfaces] of Object.entries(TEXT_SURFACES) as [TokenName, TokenName[]][]) {
    tokens[fg] = ensureContrast(
      tokens[fg],
      surfaces.map((surface) => tokens[surface]),
      dark ? "lighter" : "darker",
    );
  }
  return {
    id: input.id,
    name: input.name,
    type: input.type,
    credit: input.credit,
    tokens,
    monaco: monacoTheme(input.type, tokens),
  };
}

function monacoTheme(type: "dark" | "light", t: ThemeTokens): MonacoThemeData {
  const bare = (hex: string) => hex.slice(1);
  return {
    base: type === "dark" ? "vs-dark" : "vs",
    inherit: true,
    rules: [
      { token: "", foreground: bare(t["fg.default"]) },
      { token: "comment", foreground: bare(t["syntax.comment"]), fontStyle: "italic" },
      { token: "keyword", foreground: bare(t["syntax.keyword"]) },
      { token: "string", foreground: bare(t["syntax.string"]) },
      { token: "string.escape", foreground: bare(t["syntax.number"]) },
      { token: "number", foreground: bare(t["syntax.number"]) },
      { token: "regexp", foreground: bare(t["syntax.string"]) },
      { token: "type", foreground: bare(t["syntax.type"]) },
      { token: "type.identifier", foreground: bare(t["syntax.type"]) },
      { token: "identifier", foreground: bare(t["fg.default"]) },
      { token: "delimiter", foreground: bare(t["fg.muted"]) },
      { token: "tag", foreground: bare(t["syntax.keyword"]) },
      { token: "attribute.name", foreground: bare(t["syntax.function"]) },
    ],
    colors: {
      "editor.background": t["bg.canvas"],
      "editor.foreground": t["fg.default"],
      "editorLineNumber.foreground": t["fg.muted"],
      "editorLineNumber.activeForeground": t["fg.default"],
      "editor.lineHighlightBackground": t["bg.lineHighlight"],
      "editor.lineHighlightBorder": t["bg.lineHighlight"],
      "editor.selectionBackground": t["bg.selection"],
      "editorCursor.foreground": t["fg.accent"],
      "editorWhitespace.foreground": t["border.default"],
      "editorIndentGuide.background1": t["border.muted"],
      "editorIndentGuide.activeBackground1": t["border.default"],
      "editorGutter.background": t["bg.canvas"],
      "editorWidget.background": t["bg.elevated"],
      "editorWidget.border": t["border.default"],
      "editorSuggestWidget.background": t["bg.elevated"],
      "editorSuggestWidget.selectedBackground": t["bg.activeRow"],
      "editorHoverWidget.background": t["bg.elevated"],
      "editorError.foreground": t["fg.error"],
      "editorWarning.foreground": t["fg.warn"],
      focusBorder: t["fg.accent"],
    },
  };
}
