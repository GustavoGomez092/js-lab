import { describe, expect, test } from "bun:test";
import {
  BUILTIN_THEMES,
  CONTRAST_PAIRS,
  contrastRatio,
  ensureContrast,
  getTheme,
  hexToRgb,
  listThemes,
  resolveThemeId,
  TOKEN_NAMES,
  toCssVariables,
} from "../src";

const SPEC_THEMES = [
  "Dracula",
  "One Dark",
  "Monokai",
  "Material Darker",
  "Ayu Dark",
  "Ayu Mirage",
  "SynthWave '84",
  "Shades of Purple",
  "Nord",
  "Night Owl",
  "Catppuccin Mocha",
  "GitHub Dark",
  "Solarized Dark",
  "Tomorrow Night",
  "GitHub Light",
  "Solarized Light",
  "Catppuccin Latte",
  "Ayu Light",
  "Visual Studio Light",
];

describe("contrast", () => {
  test("computes WCAG ratios and only adjusts colors that fail", () => {
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 5);
    expect(contrastRatio("#1B1E23", "#1B1E23")).toBeCloseTo(1, 5);
    expect(ensureContrast("#D7DCE3", ["#1B1E23"], "lighter")).toBe("#D7DCE3");
    const lifted = ensureContrast("#7C8591", ["#1B1E23"], "lighter");
    expect(lifted).not.toBe("#7C8591");
    expect(contrastRatio(lifted, "#1B1E23")).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(ensureContrast("#B58900", ["#FDF6E3", "#EEE8D5"], "darker"), "#EEE8D5"),
    ).toBeGreaterThanOrEqual(4.5);
  });
});

describe("built-in themes", () => {
  test("ships Graphite, Graphite Light and every spec §9.2 theme with unique ids", () => {
    const names = listThemes().map((theme) => theme.name);
    expect(names.slice(0, 2)).toEqual(["Graphite", "Graphite Light"]);
    for (const name of SPEC_THEMES) expect(names).toContain(name);
    expect(BUILTIN_THEMES).toHaveLength(21);
    expect(new Set(BUILTIN_THEMES.map((theme) => theme.id)).size).toBe(21);
  });

  test("every text/background pair meets WCAG AA in every theme", () => {
    const failures: string[] = [];
    for (const theme of BUILTIN_THEMES) {
      for (const [fg, bg] of CONTRAST_PAIRS) {
        const ratio = contrastRatio(theme.tokens[fg], theme.tokens[bg]);
        if (ratio < 4.5) failures.push(`${theme.id}: ${fg} on ${bg} = ${ratio.toFixed(2)}`);
      }
    }
    expect(failures).toEqual([]);
  });

  // FB-m7: hovered rows are real surfaces. Warn and info text sit on bg.lineHover, and a hovered error row paints a
  // dedicated bg.errorRowHover (no CSS color-mix), so the AA check covers both.
  test("hovered output rows are covered: bg.errorRowHover and bg.lineHover are in the contrast set (FB-m7)", () => {
    expect(TOKEN_NAMES).toContain("bg.errorRowHover");
    const pairs = CONTRAST_PAIRS.map(([fg, bg]) => `${fg} on ${bg}`);
    for (const pair of [
      "fg.error on bg.errorRowHover",
      "fg.muted on bg.errorRowHover",
      "fg.accent on bg.errorRowHover",
      "fg.warn on bg.lineHover",
      "fg.info on bg.lineHover",
      "fg.default on bg.lineHover",
      "fg.accent on bg.lineHover",
    ]) {
      expect(pairs).toContain(pair);
    }
    for (const theme of BUILTIN_THEMES) {
      expect(theme.tokens["bg.errorRowHover"]).not.toBe(theme.tokens["bg.errorRow"]);
    }
  });

  test("every theme defines every token as #RRGGBB and a matching Monaco theme", () => {
    for (const theme of BUILTIN_THEMES) {
      for (const name of TOKEN_NAMES) expect(theme.tokens[name]).toMatch(/^#[0-9A-F]{6}$/);
      expect(theme.monaco.base).toBe(theme.type === "dark" ? "vs-dark" : "vs");
      expect(theme.monaco.colors["editor.background"]).toBe(theme.tokens["bg.canvas"]);
      expect(theme.monaco.rules[0]).toEqual({ token: "", foreground: theme.tokens["fg.default"].slice(1) });
      expect(theme.credit.length).toBeGreaterThan(0);
    }
  });

  test("Graphite keeps the chosen tokens and lifts fg.muted only as far as AA needs", () => {
    const graphite = getTheme("graphite");
    expect(graphite.tokens).toMatchObject({
      "bg.canvas": "#1B1E23",
      "bg.chrome": "#16191D",
      "fg.default": "#D7DCE3",
      "fg.accent": "#6F9BFF",
      "fg.error": "#F07178",
      "bg.activeRow": "#243152",
      "bg.errorRow": "#2A1D21",
    });
    // Lifted just enough for AA on every muted surface, including bg.hover and bg.errorRow: #8A929D is
    // +14/+13/+12 per channel.
    const [r, g, b] = hexToRgb(graphite.tokens["fg.muted"]);
    for (const [channel, original] of [
      [r, 0x7c],
      [g, 0x85],
      [b, 0x91],
    ] as const) {
      expect(channel - original).toBeGreaterThanOrEqual(0);
      expect(channel - original).toBeLessThanOrEqual(16);
    }
    expect(contrastRatio(graphite.tokens["fg.muted"], graphite.tokens["bg.hover"])).toBeGreaterThanOrEqual(4.5);
    const light = getTheme("graphite-light");
    expect(light.type).toBe("light");
    expect(light.tokens["bg.canvas"]).toBe("#F7F8FA");
  });

  test("theme resolution follows the system pair and falls back to Graphite", () => {
    const appearance = { theme: "nord", followSystem: false, lightTheme: "github-light", darkTheme: "dracula" };
    expect(resolveThemeId(appearance, true)).toBe("nord");
    expect(resolveThemeId({ ...appearance, followSystem: true }, true)).toBe("dracula");
    expect(resolveThemeId({ ...appearance, followSystem: true }, false)).toBe("github-light");
    expect(resolveThemeId({ ...appearance, theme: "missing" }, true)).toBe("graphite");
    expect(resolveThemeId({ ...appearance, followSystem: true, lightTheme: "missing" }, false)).toBe("graphite-light");
    expect(getTheme("missing").id).toBe("graphite");
  });

  test("tokens become CSS variables", () => {
    const vars = toCssVariables(getTheme("graphite").tokens);
    expect(vars["--bg-canvas"]).toBe("#1B1E23");
    expect(vars["--console-error"]).toBe("#F07178");
    expect(Object.keys(vars)).toHaveLength(TOKEN_NAMES.length);
  });
});
