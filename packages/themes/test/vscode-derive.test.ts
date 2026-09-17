import { describe, expect, test } from "bun:test";
import { buildTheme, type Palette } from "../src/build";
import { AA, contrastRatio, mix } from "../src/contrast";
import { CONTRAST_PAIRS, TOKEN_NAMES } from "../src/tokens";
import { normalizeHex, paletteFromColors, type SyntaxKey, themeTypeFrom } from "../src/vscode/derive";

/** The bar the 21 built-ins already meet in themes.test.ts, applied to a theme derived from `colors`. */
function aaFailures(
  colors: Record<string, unknown>,
  type: "dark" | "light",
  syntax: Partial<Record<SyntaxKey, string>> = {},
): string[] {
  const theme = buildTheme({
    id: "derived",
    name: "Derived",
    type,
    credit: "test",
    palette: paletteFromColors(colors, type, syntax),
  });
  return CONTRAST_PAIRS.flatMap(([fg, bg]) => {
    const ratio = contrastRatio(theme.tokens[fg], theme.tokens[bg]);
    return ratio < AA ? [`${fg} on ${bg} = ${ratio.toFixed(2)}`] : [];
  });
}

describe("normalizeHex", () => {
  test("expands short forms, uppercases, and composites alpha over the given surface", () => {
    expect(normalizeHex("#abc", "#000000")).toBe("#AABBCC");
    expect(normalizeHex("#1E1E1E", "#000000")).toBe("#1E1E1E");
    // 50% white over black is mid grey; the alpha channel must actually be applied, not sliced off.
    expect(normalizeHex("#FFFFFF80", "#000000")).toBe("#808080");
    expect(normalizeHex("#FFFFFF00", "#123456")).toBe("#123456");
    expect(normalizeHex("not a color", "#000000")).toBeNull();
    expect(normalizeHex(undefined, "#000000")).toBeNull();
    expect(normalizeHex(42, "#000000")).toBeNull();
  });

  test("a 4-digit form carries its alpha, and the surface underneath decides the result", () => {
    // #abc8 expands to #AABBCC88, so the same declaration composites to two different colours.
    expect(normalizeHex("#abc8", "#000000")).toBe(mix("#000000", "#AABBCC", 0x88 / 255));
    expect(normalizeHex("#abc8", "#FFFFFF")).toBe(mix("#FFFFFF", "#AABBCC", 0x88 / 255));
    expect(normalizeHex("#abc8", "#000000")).not.toBe("#AABBCC");
    expect(normalizeHex("#abc8", "#000000")).toBe(normalizeHex("#AABBCC88", "#000000"));
    // A fully opaque 8-digit value is the plain colour, whatever it is drawn on.
    expect(normalizeHex("#AABBCCFF", "#123456")).toBe("#AABBCC");
  });

  test("rejects everything that is not a 3/4/6/8-digit hex colour", () => {
    for (const bad of ["", "#", "#12", "#12345", "#1234567", "#123456789", "abcdef", "#12345g", "rgb(0,0,0)"]) {
      expect(`${bad}=${normalizeHex(bad, "#000000")}`).toBe(`${bad}=null`);
    }
    for (const bad of [null, true, 0, {}, ["#abcdef"]]) expect(normalizeHex(bad, "#000000")).toBeNull();
    // Surrounding whitespace is tolerated; interior whitespace is not.
    expect(normalizeHex("  #abcdef \n", "#000000")).toBe("#ABCDEF");
    expect(normalizeHex("#ab cdef", "#000000")).toBeNull();
  });
});

describe("themeTypeFrom", () => {
  test("honours a declared type and otherwise infers from the background's luminance", () => {
    expect(themeTypeFrom({}, "light")).toBe("light");
    expect(themeTypeFrom({}, "vs-dark")).toBe("dark");
    expect(themeTypeFrom({ "editor.background": "#FFFFFF" }, undefined)).toBe("light");
    expect(themeTypeFrom({ "editor.background": "#1E1E1E" }, undefined)).toBe("dark");
    expect(themeTypeFrom({}, undefined)).toBe("dark");
  });

  test("knows every uiTheme spelling VS Code ships, case- and space-insensitively", () => {
    // Each spelling is judged against a background that infers the OPPOSITE type, so only the declaration can
    // produce the expected answer. Asserted against {} instead, a dropped dark spelling still answers "dark" via
    // the unknown-background default and the assertion proves nothing.
    const black = { "editor.background": "#000000" };
    const white = { "editor.background": "#FFFFFF" };
    for (const declared of ["light", "vs", "hc-light", " LIGHT ", "Vs"]) {
      expect(`${declared}=${themeTypeFrom(black, declared)}`).toBe(`${declared}=light`);
    }
    for (const declared of ["dark", "vs-dark", "hc-black", " DARK "]) {
      expect(`${declared}=${themeTypeFrom(white, declared)}`).toBe(`${declared}=dark`);
    }
  });

  test("an unrecognised or non-string declaration falls through to the background rather than winning", () => {
    const white = { "editor.background": "#FFFFFF" };
    for (const declared of ["hc", "", 42, null, {}, ["light"]]) expect(themeTypeFrom(white, declared)).toBe("light");
    expect(themeTypeFrom({ "editor.background": "#0F0F0F" }, "nonsense")).toBe("dark");
  });

  test("the split sits where white and black text tie, not at half luminance", () => {
    // #767676 reads better in black than in white, so it is a light background even though its relative luminance
    // is only 0.18. A 0.5 threshold would call it dark and paint white text on it below AA, which nothing can fix.
    expect(contrastRatio("#767676", "#000000")).toBeGreaterThan(contrastRatio("#767676", "#FFFFFF"));
    expect(contrastRatio("#757575", "#FFFFFF")).toBeGreaterThan(contrastRatio("#757575", "#000000"));
    expect(themeTypeFrom({ "editor.background": "#767676" }, undefined)).toBe("light");
    expect(themeTypeFrom({ "editor.background": "#757575" }, undefined)).toBe("dark");
    // An alpha background is composited over black before it is judged, so it is never taken brighter than it reads.
    expect(themeTypeFrom({ "editor.background": "#FFFFFF10" }, undefined)).toBe("dark");
  });
});

describe("paletteFromColors", () => {
  test("reads the spec §9.3 keys when the theme provides them", () => {
    const palette = paletteFromColors(
      {
        "editor.background": "#1E1E1E",
        "editor.foreground": "#D4D4D4",
        "sideBar.background": "#252526",
        "activityBar.background": "#333333",
        "statusBar.background": "#007ACC",
        focusBorder: "#007FD4",
        errorForeground: "#F48771",
        "editor.selectionBackground": "#264F78",
      },
      "dark",
      { comment: "#6A9955", keyword: "#C586C0" },
    );
    expect(palette.canvas).toBe("#1E1E1E");
    expect(palette.fg).toBe("#D4D4D4");
    expect(palette.chrome).toBe("#252526");
    expect(palette.accent).toBe("#007FD4");
    expect(palette.error).toBe("#F48771");
    expect(palette.selection).toBe("#264F78");
    expect(palette.comment).toBe("#6A9955");
    expect(palette.keyword).toBe("#C586C0");
  });

  test("every field is an opaque #RRGGBB even when the theme defines nothing", () => {
    const palette = paletteFromColors({}, "dark", {});
    for (const [key, value] of Object.entries(palette)) {
      expect(`${key}=${value}`).toMatch(/=#[0-9A-F]{6}$/);
    }
  });

  test("with nothing declared, every field is the documented derivation of the default dark canvas", () => {
    const canvas = "#1B1E23";
    const fg = mix(canvas, "#FFFFFF", 0.85);
    expect(paletteFromColors({}, "dark", {})).toEqual({
      canvas,
      chrome: mix(canvas, "#000000", 0.25),
      elevated: mix(canvas, "#FFFFFF", 0.06),
      border: mix(canvas, "#FFFFFF", 0.12),
      fg,
      muted: mix(fg, canvas, 0.35),
      accent: "#6F9BFF",
      error: "#F07178",
      warn: "#E5C07B",
      success: "#5CC28A",
      info: "#7FD1C7",
      string: "#C3E88D",
      number: "#F5A97F",
      keyword: "#6F9BFF",
      fn: "#FFD580",
      type: "#7FD1C7",
      comment: mix(fg, canvas, 0.45),
      selection: mix(canvas, "#6F9BFF", 0.3),
      lineHighlight: mix(canvas, "#FFFFFF", 0.05),
    });
  });

  test("the light defaults are their own palette, not the dark one with the mixes pointed the other way", () => {
    const canvas = "#F7F8FA";
    const fg = mix(canvas, "#000000", 0.9);
    expect(paletteFromColors({}, "light", {})).toEqual({
      canvas,
      chrome: mix(canvas, "#000000", 0.06),
      // 3% toward white rounds away entirely on a canvas this pale, so the elevated surface turns around.
      elevated: mix(canvas, "#000000", 0.03),
      border: mix(canvas, "#000000", 0.12),
      fg,
      muted: mix(fg, canvas, 0.35),
      accent: "#2F52C9",
      error: "#B42330",
      warn: "#8A5A00",
      success: "#1F7A45",
      info: "#0B6E78",
      string: "#2E7D32",
      number: "#A2551A",
      keyword: "#2F52C9",
      fn: "#8A5A00",
      type: "#0B6E78",
      comment: mix(fg, canvas, 0.45),
      selection: mix(canvas, "#2F52C9", 0.2),
      lineHighlight: mix(canvas, "#000000", 0.05),
    });
  });
});

// Every VS Code key spec §9.3 names, plus the ones its "and so on" stands for. Deleting any row from the
// implementation's fallback chains has to break this table.
const FALLBACK_KEYS: readonly (readonly [keyof Palette, string])[] = [
  ["canvas", "editor.background"],
  ["fg", "editor.foreground"],
  ["fg", "foreground"],
  ["chrome", "sideBar.background"],
  ["chrome", "activityBar.background"],
  ["chrome", "statusBar.background"],
  ["elevated", "editorWidget.background"],
  ["elevated", "dropdown.background"],
  ["elevated", "menu.background"],
  ["border", "panel.border"],
  ["border", "editorGroup.border"],
  ["border", "contrastBorder"],
  ["border", "widget.border"],
  ["muted", "descriptionForeground"],
  ["muted", "editorLineNumber.foreground"],
  ["accent", "focusBorder"],
  ["accent", "textLink.foreground"],
  ["accent", "button.background"],
  ["accent", "progressBar.background"],
  ["error", "errorForeground"],
  ["error", "editorError.foreground"],
  ["error", "list.errorForeground"],
  ["warn", "editorWarning.foreground"],
  ["warn", "list.warningForeground"],
  ["info", "editorInfo.foreground"],
  ["info", "textLink.activeForeground"],
  ["success", "gitDecoration.addedResourceForeground"],
  ["success", "terminal.ansiGreen"],
  ["selection", "editor.selectionBackground"],
  ["selection", "selection.background"],
  ["lineHighlight", "editor.lineHighlightBackground"],
];

describe("the §9.3 fallback chains", () => {
  test("every listed key, on its own, supplies its field", () => {
    // Dark enough to clear the surface guard untouched, and equal to no derived default.
    const declared = "#402030";
    const missed = FALLBACK_KEYS.filter(
      ([field, key]) => paletteFromColors({ [key]: declared }, "dark", {})[field] !== declared,
    );
    expect(missed.map(([field, key]) => `${key} -> ${field}`)).toEqual([]);
  });

  test("when a whole chain is present the first key wins", () => {
    const colors: Record<string, string> = {};
    FALLBACK_KEYS.forEach(([, key], index) => {
      colors[key] = `#${(0x201010 + index * 0x010101).toString(16).toUpperCase()}`;
    });
    const palette = paletteFromColors(colors, "dark", {});
    const firstKeyFor = new Map<keyof Palette, string>();
    for (const [field, key] of FALLBACK_KEYS) if (!firstKeyFor.has(field)) firstKeyFor.set(field, key);
    const wrong = [...firstKeyFor].filter(([field, key]) => palette[field] !== colors[key]);
    expect(wrong.map(([field, key]) => `${field} should come from ${key}`)).toEqual([]);
  });

  test("keyword and type default to the accent and info the theme actually declared", () => {
    const palette = paletteFromColors({ focusBorder: "#402030", "editorInfo.foreground": "#204030" }, "dark", {});
    expect(palette.keyword).toBe("#402030");
    expect(palette.type).toBe("#204030");
  });

  test("syntax colours win over those defaults and are normalised like any other value", () => {
    const syntax = { comment: "#6a9955", keyword: "#c586c0", string: "#8f8", number: "#abcd", type: "#4ec9b0" };
    const palette = paletteFromColors({ focusBorder: "#402030" }, "dark", syntax);
    expect(palette.comment).toBe("#6A9955");
    expect(palette.keyword).toBe("#C586C0");
    expect(palette.string).toBe("#88FF88");
    expect(palette.number).toBe(mix("#1B1E23", "#AABBCC", 0xdd / 255));
    expect(palette.type).toBe("#4EC9B0");
    // A syntax slot that is not a colour falls back instead of reaching buildTheme, which would throw on it.
    expect(paletteFromColors({}, "dark", { fn: "inherit" }).fn).toBe("#FFD580");
  });
});

describe("contrast fallbacks", () => {
  test("a sparse theme's built palette meets WCAG AA on every surface (spec §9.1)", () => {
    const sparse = { "editor.background": "#101010" };
    const theme = buildTheme({
      id: "sparse",
      name: "Sparse",
      type: "dark",
      credit: "test",
      palette: paletteFromColors(sparse, "dark", {}),
    });
    expect(Object.keys(theme.tokens).sort()).toEqual([...TOKEN_NAMES].sort());
    expect(aaFailures(sparse, "dark")).toEqual([]);
  });

  test("the same holds for a sparse light theme, and for a theme that defines nothing at all", () => {
    for (const [type, colors] of [
      ["light", { "editor.background": "#FFFFFF" }],
      ["dark", {}],
      ["light", {}],
      ["dark", { "editor.background": "#000000" }],
    ] as const) {
      expect(`${type}:${aaFailures(colors, type).join()}`).toBe(`${type}:`);
    }
  });

  // buildTheme's ensureContrast can only move TEXT toward white or black. A surface that fails AA against white in
  // a dark theme is therefore unfixable there — white-on-white is the best it can do. Each case below declares
  // exactly one such surface, so each one names a guard that has to fire.
  const HOSTILE: readonly (readonly [string, "dark" | "light", Record<string, unknown>])[] = [
    ["canvas", "dark", { "editor.background": "#FFFFFF" }],
    ["canvas", "light", { "editor.background": "#000000" }],
    ["chrome", "dark", { "sideBar.background": "#FFFFFF" }],
    ["chrome", "light", { "sideBar.background": "#000000" }],
    ["elevated", "dark", { "editorWidget.background": "#FFFFFF" }],
    ["elevated", "light", { "dropdown.background": "#000000" }],
    ["selection", "dark", { "editor.selectionBackground": "#FFFFFF" }],
    ["selection", "light", { "selection.background": "#000000" }],
    ["accent", "dark", { focusBorder: "#FFFFFF" }],
    ["accent", "light", { "textLink.foreground": "#000000" }],
    // A canvas that only just clears AA leaves no headroom for the error tint buildTheme paints over it.
    ["error", "dark", { "editor.background": "#FFFFFF", errorForeground: "#FF0000" }],
    ["error", "light", { "editor.background": "#000000", "editorError.foreground": "#FF0000" }],
    // A bright foreground is what lifts bg.hover out of range, so the elevated surface has to absorb it.
    ["hover", "dark", { "editorWidget.background": "#FFFFFF", "editor.foreground": "#FFFFFF" }],
    // bg.activeRow is 18% of the accent over the ELEVATED surface, not over the canvas. An elevated surface left
    // sitting exactly on the AA boundary is what a bright accent then tips over, so the accent answers for it.
    ["activeRow", "dark", { "editorWidget.background": "#FFFFFF", focusBorder: "#FFFFFF" }],
    ["everything", "dark", { "editor.background": "#FFF", "sideBar.background": "#FFF", focusBorder: "#FFF" }],
  ];

  test("a theme whose own colours are unreadable is corrected, surface by surface", () => {
    const broken = HOSTILE.flatMap(([surface, type, colors]) => {
      const failures = aaFailures(colors, type);
      return failures.length === 0 ? [] : [`${type} ${surface}: ${failures.join(", ")}`];
    });
    expect(broken).toEqual([]);
  });

  test("the guard corrects the offending surface and leaves the rest of the theme alone", () => {
    const palette = paletteFromColors({ "editor.selectionBackground": "#FFFFFF", focusBorder: "#007FD4" }, "dark", {});
    expect(palette.selection).not.toBe("#FFFFFF");
    expect(contrastRatio("#FFFFFF", palette.selection)).toBeGreaterThanOrEqual(AA);
    expect(palette.accent).toBe("#007FD4");
    expect(palette.canvas).toBe("#1B1E23");
  });

  test("a theme that is already legible is passed through untouched, guard and all", () => {
    const colors = {
      "editor.background": "#1E1E1E",
      "sideBar.background": "#252526",
      "editorWidget.background": "#252526",
      "editor.selectionBackground": "#264F78",
      focusBorder: "#007FD4",
      errorForeground: "#F48771",
    };
    expect(paletteFromColors(colors, "dark", {})).toMatchObject({
      canvas: "#1E1E1E",
      chrome: "#252526",
      elevated: "#252526",
      selection: "#264F78",
      accent: "#007FD4",
      error: "#F48771",
    });
    expect(aaFailures(colors, "dark")).toEqual([]);
  });

  test("the three chrome surfaces stay distinct even when the canvas is pure black or pure white", () => {
    for (const [type, background] of [
      ["dark", "#000000"],
      ["light", "#FFFFFF"],
      ["dark", "#1B1E23"],
      ["light", "#F7F8FA"],
    ] as const) {
      const { canvas, chrome, elevated } = paletteFromColors({ "editor.background": background }, type, {});
      expect(`${background}:${new Set([canvas, chrome, elevated]).size}`).toBe(`${background}:3`);
    }
  });

  test("an alpha selection is composited over the canvas, not passed through to buildTheme", () => {
    // "#264F7840" is the shape VS Code themes use constantly; hexToRgb would throw on it.
    const colors = { "editor.background": "#1E1E1E", "editor.selectionBackground": "#264F7840" };
    const palette = paletteFromColors(colors, "dark", {});
    expect(palette.selection).toBe(mix("#1E1E1E", "#264F78", 0x40 / 255));
    expect(() => buildTheme({ id: "a", name: "A", type: "dark", credit: "t", palette })).not.toThrow();
  });
});
