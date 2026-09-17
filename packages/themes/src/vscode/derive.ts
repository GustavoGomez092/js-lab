import type { Palette } from "../build";
import { AA, contrastRatio, mix, relativeLuminance } from "../contrast";

export type SyntaxKey = "comment" | "keyword" | "string" | "number" | "type" | "fn";

/**
 * A VS Code colour as an opaque `#RRGGBB`, or null when it isn't a colour at all.
 *
 * `#RGB`/`#RGBA` expand; an alpha channel is composited over `over`, because `hexToRgb` (contrast.ts) accepts
 * only `#RRGGBB` and real themes use 8-digit hex for selections and overlays constantly.
 */
export function normalizeHex(value: unknown, over: string): string | null {
  if (typeof value !== "string") return null;
  const match = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value.trim());
  const digits = match?.[1];
  if (!digits) return null;
  const expanded = digits.length <= 4 ? [...digits].map((c) => c + c).join("") : digits;
  const opaque = `#${expanded.slice(0, 6).toUpperCase()}`;
  if (expanded.length === 6) return opaque;
  return mix(over, opaque, Number.parseInt(expanded.slice(6, 8), 16) / 255);
}

/**
 * The luminance where white and black text contrast equally: `sqrt(1.05 * 0.05) - 0.05`. Above it a background
 * reads better in black, so the theme is light. Splitting at 0.5 instead would call `#808080` dark and put white
 * text on it at ratio 3.9 — below AA and unfixable, since nothing is lighter than white.
 */
const LIGHT_ABOVE = Math.sqrt(1.05 * 0.05) - 0.05;

/** `light` / `vs` / `hc-light` wins; otherwise the editor background decides. Unknown means dark. */
export function themeTypeFrom(colors: Record<string, unknown>, declared: unknown): "dark" | "light" {
  if (typeof declared === "string") {
    const value = declared.trim().toLowerCase();
    if (value === "light" || value === "vs" || value === "hc-light") return "light";
    if (value === "dark" || value === "vs-dark" || value === "hc-black") return "dark";
  }
  const background = normalizeHex(colors["editor.background"], "#000000");
  if (background === null) return "dark";
  return relativeLuminance(background) > LIGHT_ABOVE ? "light" : "dark";
}

/**
 * `colors` → a complete `Palette`, with a fallback behind every field (spec §9.3: "UI variables are derived from
 * `editor.background`, `sideBar.background`, `activityBar.background`, `statusBar.background`, `focusBorder`,
 * `errorForeground`, and so on, with contrast fallbacks").
 *
 * `buildTheme` then lifts every foreground to WCAG AA — but it can only move text toward white or black, so it can
 * only succeed on surfaces the theme's own text direction can reach. Those surfaces are settled here, which is what
 * makes an imported theme meet the same bar as the 21 built-ins rather than merely aim at it.
 */
export function paletteFromColors(
  colors: Record<string, unknown>,
  type: "dark" | "light",
  syntax: Partial<Record<SyntaxKey, string>>,
): Palette {
  const dark = type === "dark";
  const ink = dark ? "#FFFFFF" : "#000000";
  const away = dark ? "#000000" : "#FFFFFF";

  /**
   * A surface `buildTheme` can actually put text on. `derived` names the further surfaces buildTheme mixes out of
   * this one, because those carry text too. The first candidate that clears AA against `ink` wins, so a colour that
   * is already legible comes back untouched and only an unreadable one is pushed away from the text.
   */
  const settle = (base: string, derived: (candidate: string) => readonly string[] = (c) => [c]): string => {
    let candidate = base;
    const legible = () => derived(candidate).every((surface) => contrastRatio(ink, surface) >= AA);
    for (let step = 1; step <= 100 && !legible(); step++) candidate = mix(base, away, step / 100);
    return candidate;
  };

  const canvas = settle(normalizeHex(colors["editor.background"], away) ?? (dark ? "#1B1E23" : "#F7F8FA"));
  const pick = (...keys: string[]): string | null => {
    for (const key of keys) {
      const value = normalizeHex(colors[key], canvas);
      if (value !== null) return value;
    }
    return null;
  };
  /** Toward the theme's own text colour, which is the one direction that always has room. */
  const forward = (base: string, amount: number) => mix(base, ink, amount);
  /** Chrome recedes (Graphite #16191D behind #1B1E23; Graphite Light #ECEEF1 behind #F7F8FA), elevated rises. */
  const shift = (base: string, target: string, amount: number) => {
    const moved = mix(base, target, amount);
    // A black canvas has nothing behind it and a white one nothing above it; turn around rather than collapse onto
    // the canvas. The two callers use different amounts, so the turnarounds cannot land on each other either.
    return moved === base ? mix(base, target === "#000000" ? "#FFFFFF" : "#000000", amount) : moved;
  };

  const fg = pick("editor.foreground", "foreground") ?? forward(canvas, dark ? 0.85 : 0.9);
  // bg.hover is 6% of fg over this surface, so a foreground bright enough to lift it past AA counts against it.
  const elevated = settle(
    pick("editorWidget.background", "dropdown.background", "menu.background") ??
      shift(canvas, "#FFFFFF", dark ? 0.06 : 0.03),
    (candidate) => [candidate, mix(candidate, fg, 0.06)],
  );
  // bg.accentMuted, bg.lineHover and bg.activeRow are all mixed out of the accent, and all three carry text.
  const accent = settle(
    pick("focusBorder", "textLink.foreground", "button.background", "progressBar.background") ??
      (dark ? "#6F9BFF" : "#2F52C9"),
    (candidate) => [
      mix(canvas, candidate, dark ? 0.28 : 0.16),
      mix(canvas, candidate, dark ? 0.16 : 0.12),
      mix(elevated, candidate, 0.18),
    ],
  );
  // bg.errorRow is a 10% error tint over the canvas; fg.error and fg.muted are both read on it.
  const error = settle(
    pick("errorForeground", "editorError.foreground", "list.errorForeground") ?? (dark ? "#F07178" : "#B42330"),
    (candidate) => [mix(canvas, candidate, dark ? 0.1 : 0.08)],
  );
  const info = pick("editorInfo.foreground", "textLink.activeForeground") ?? (dark ? "#7FD1C7" : "#0B6E78");
  // Syntax colours arrive from a parsed theme file, so they are normalised like every other untrusted value.
  const syntaxColor = (key: SyntaxKey, fallback: string) => normalizeHex(syntax[key], canvas) ?? fallback;

  return {
    canvas,
    chrome: settle(
      pick("sideBar.background", "activityBar.background", "statusBar.background") ??
        shift(canvas, "#000000", dark ? 0.25 : 0.06),
    ),
    elevated,
    border: pick("panel.border", "editorGroup.border", "contrastBorder", "widget.border") ?? forward(canvas, 0.12),
    fg,
    muted: pick("descriptionForeground", "editorLineNumber.foreground") ?? mix(fg, canvas, 0.35),
    accent,
    error,
    warn: pick("editorWarning.foreground", "list.warningForeground") ?? (dark ? "#E5C07B" : "#8A5A00"),
    success: pick("gitDecoration.addedResourceForeground", "terminal.ansiGreen") ?? (dark ? "#5CC28A" : "#1F7A45"),
    info,
    string: syntaxColor("string", dark ? "#C3E88D" : "#2E7D32"),
    number: syntaxColor("number", dark ? "#F5A97F" : "#A2551A"),
    keyword: syntaxColor("keyword", accent),
    fn: syntaxColor("fn", dark ? "#FFD580" : "#8A5A00"),
    type: syntaxColor("type", info),
    comment: syntaxColor("comment", mix(fg, canvas, 0.45)),
    selection: settle(
      pick("editor.selectionBackground", "selection.background") ?? mix(canvas, accent, dark ? 0.3 : 0.2),
    ),
    lineHighlight: pick("editor.lineHighlightBackground") ?? forward(canvas, 0.05),
  };
}
