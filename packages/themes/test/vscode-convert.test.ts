import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildTheme, type ThemeDefinition } from "../src/build";
import { AA, contrastRatio, mix } from "../src/contrast";
import { convertVsCodeTheme as convertFromBarrel, monacoTokenForScope, normalizeHex } from "../src/index";
import { CONTRAST_PAIRS, TOKEN_NAMES } from "../src/tokens";
import { type ConvertResult, convertVsCodeTheme, slugThemeId } from "../src/vscode/convert";
import { paletteFromColors } from "../src/vscode/derive";

const FIXTURES = join(import.meta.dir, "fixtures");

/** What `build.ts` itself emits, derived rather than restated so the two cannot drift apart. */
const PROBE = buildTheme({
  id: "probe",
  name: "Probe",
  type: "dark",
  credit: "test",
  palette: paletteFromColors({}, "dark", {}),
});
const EDITOR_TOKENS = new Set(PROBE.monaco.rules.map((rule) => rule.token));
const BUILTIN_RULE_COUNT = PROBE.monaco.rules.length;

function ok(result: ConvertResult): ThemeDefinition {
  if (!result.ok) throw new Error(result.error);
  return result.theme;
}

function refusal(result: ConvertResult): string {
  if (result.ok) throw new Error("expected a refusal");
  return result.error;
}

function convertFixture(file: string): ThemeDefinition {
  const raw = JSON.parse(readFileSync(join(FIXTURES, file), "utf8")) as unknown;
  return ok(convertVsCodeTheme(raw, { fallbackName: file.replace(/\.json$/, "") }));
}

function aaFailures(theme: ThemeDefinition): string[] {
  return CONTRAST_PAIRS.flatMap(([fg, bg]) =>
    contrastRatio(theme.tokens[fg], theme.tokens[bg]) < AA ? [`${fg}/${bg}`] : [],
  );
}

describe("slugThemeId", () => {
  test("produces an id the Themes menu accepts (menu.ts's /^[\\w-]{1,64}$/)", () => {
    expect(slugThemeId("  Ayu  Mirage!! ")).toBe("ayu-mirage");
    expect(slugThemeId("Dracula")).toBe("dracula");
    expect(slugThemeId("日本語")).toBe("imported-theme");
    expect(slugThemeId("")).toBe("imported-theme");
    expect(slugThemeId("x".repeat(200))).toHaveLength(64);
    for (const name of ["  Ayu  Mirage!! ", "Dracula", "日本語", "", "x".repeat(200)]) {
      expect(slugThemeId(name)).toMatch(/^[\w-]{1,64}$/);
    }
  });

  test("collapses every run of non-alphanumerics to a single dash, lowercased", () => {
    expect(slugThemeId("Solarized (Dark)")).toBe("solarized-dark");
    expect(slugThemeId("One_Dark Pro")).toBe("one-dark-pro");
    expect(slugThemeId("Night Owl 2.0")).toBe("night-owl-2-0");
    expect(slugThemeId("café")).toBe("caf");
  });

  test("never begins or ends with a dash, including when the 64-character cut lands on one", () => {
    expect(slugThemeId("!!Dracula")).toBe("dracula");
    expect(slugThemeId("Dracula!!")).toBe("dracula");
    // "a"*63 + "-b" is 65 characters, so the cut leaves a trailing dash that only a second strip removes.
    expect(slugThemeId(`${"a".repeat(63)} b`)).toBe("a".repeat(63));
    expect(slugThemeId(`${"a".repeat(64)} b`)).toBe("a".repeat(64));
    for (const name of ["!!Dracula", "Dracula!!", `${"a".repeat(63)} b`, "Solarized (Dark)", "日本語"]) {
      expect(`${name}=${slugThemeId(name)}`).not.toMatch(/-$/);
    }
  });
});

/** The ten fixtures spec §22.1 asks for, each with the id and type converting it must produce. */
const EXPECTED: readonly (readonly [file: string, id: string, type: "dark" | "light"])[] = [
  ["alpha-colors.json", "jslab-test-alpha", "dark"],
  ["array-scopes.json", "jslab-test-arrays", "dark"],
  ["dark-full.json", "jslab-test-dark", "dark"],
  ["dark-minimal.json", "jslab-test-minimal", "dark"],
  ["empty-tokencolors.json", "jslab-test-empty-tokens", "light"],
  ["font-styles.json", "jslab-test-font-styles", "dark"],
  ["light-full.json", "jslab-test-light", "light"],
  ["no-type.json", "jslab-test-inferred", "light"],
  ["unknown-scopes.json", "jslab-test-unknown", "dark"],
  ["weird-name.json", "ayu-mirage", "dark"],
];

describe("convertVsCodeTheme, over the fixtures", () => {
  test("the fixture set is the ten themes spec §22.1 asks for", () => {
    const files = readdirSync(FIXTURES).filter((name) => name.endsWith(".json"));
    expect(files).toHaveLength(10);
    expect(files.sort()).toEqual(EXPECTED.map(([file]) => file));
  });

  test("converts every fixture into a complete, AA-clean theme (spec §22.1)", () => {
    for (const [file, id, type] of EXPECTED) {
      const theme = convertFixture(file);
      expect(`${file}:${theme.id}:${theme.type}`).toBe(`${file}:${id}:${type}`);
      expect(theme.id).toMatch(/^[\w-]{1,64}$/);
      expect(theme.credit).toBe("Imported VS Code theme");
      expect(Object.keys(theme.tokens).sort()).toEqual([...TOKEN_NAMES].sort());
      for (const name of TOKEN_NAMES) expect(`${file}:${theme.tokens[name]}`).toMatch(/:#[0-9A-F]{6}$/);
      expect(theme.monaco.base).toBe(type === "dark" ? "vs-dark" : "vs");
      expect(theme.monaco.inherit).toBe(true);
      expect(`${file}:${aaFailures(theme).join()}`).toBe(`${file}:`);
    }
  });

  test("every fixture's Monaco payload is one Monaco can actually take", () => {
    for (const [file] of EXPECTED) {
      const { monaco } = convertFixture(file);
      for (const [key, value] of Object.entries(monaco.colors)) {
        expect(`${file}:${key}=${value}`).toMatch(/=#[0-9A-F]{6}$/);
      }
      // A rule naming a token build.ts never emits is a rule Monaco's tokenizer never produces — see `tag.function`.
      const unknown = monaco.rules.map((rule) => rule.token).filter((token) => !EDITOR_TOKENS.has(token));
      expect(`${file}:${unknown.join()}`).toBe(`${file}:`);
      const badHex = monaco.rules.filter(
        (rule) => rule.foreground !== undefined && !/^[0-9A-F]{6}$/.test(rule.foreground),
      );
      expect(`${file}:${badHex.map((rule) => rule.token).join()}`).toBe(`${file}:`);
    }
  });

  test("dark-full: the theme's own §9.3 colours reach the palette and Monaco alike", () => {
    const theme = convertFixture("dark-full.json");
    expect(theme.tokens["bg.canvas"]).toBe("#1E2127");
    expect(theme.tokens["bg.chrome"]).toBe("#181B20");
    expect(theme.tokens["bg.elevated"]).toBe("#23272E");
    expect(theme.tokens["bg.selection"]).toBe("#3E4451");
    expect(theme.tokens["syntax.string"]).toBe("#98C379");
    // A key build.ts never derives is carried through; one it does derive is overridden by the theme's own value.
    expect(theme.monaco.colors["titleBar.activeBackground"]).toBe("#1E2127");
    expect(theme.monaco.colors["editorCursor.foreground"]).toBe("#528BFF");
    expect(theme.tokens["fg.accent"]).not.toBe("#528BFF");
  });

  test("dark-minimal: one declared colour and no tokenColors is enough", () => {
    const theme = convertFixture("dark-minimal.json");
    expect(theme.tokens["bg.canvas"]).toBe("#10131A");
    expect(theme.monaco.colors["editor.background"]).toBe("#10131A");
    expect(theme.monaco.rules).toHaveLength(BUILTIN_RULE_COUNT);
  });

  test("alpha-colors: short and 8-digit hex are expanded and composited before Monaco sees them", () => {
    const { monaco } = convertFixture("alpha-colors.json");
    expect(monaco.colors["editor.selectionBackground"]).toBe(mix("#101418", "#264F78", 0x40 / 255));
    expect(monaco.colors["editor.lineHighlightBackground"]).toBe(mix("#101418", "#FFFFFF", 0x0a / 255));
    expect(monaco.colors["list.hoverBackground"]).toBe(mix("#101418", "#FFFFFF", 0x12 / 255));
    expect(monaco.colors["editorCursor.foreground"]).toBe("#55AAFF");
    // The alpha is applied, not sliced off.
    expect(monaco.colors["editor.selectionBackground"]).not.toBe("#264F78");
  });

  test("array-scopes: array members and comma-joined lists both map, once each", () => {
    const imported = convertFixture("array-scopes.json").monaco.rules.slice(BUILTIN_RULE_COUNT);
    expect(imported).toEqual([
      { token: "comment", foreground: "7A8290" },
      { token: "keyword", foreground: "C678DD" },
      { token: "string", foreground: "98C379" },
      { token: "regexp", foreground: "98C379" },
      { token: "string.escape", foreground: "98C379" },
    ]);
  });

  test("font-styles: italic, bold and underline survive, with a foreground or without one", () => {
    const rules = convertFixture("font-styles.json").monaco.rules;
    expect(rules).toContainEqual({ token: "comment", foreground: "6B7280", fontStyle: "italic" });
    expect(rules).toContainEqual({ token: "keyword", foreground: "C792EA", fontStyle: "bold" });
    expect(rules).toContainEqual({ token: "tag", fontStyle: "underline" });
    expect(rules).toContainEqual({ token: "attribute.name", fontStyle: "italic underline" });
  });

  test("unknown-scopes: an unmapped scope contributes nothing, and a prefix matches whole segments only", () => {
    const imported = convertFixture("unknown-scopes.json").monaco.rules.slice(BUILTIN_RULE_COUNT);
    // `commentary.block` is not a comment and `stringify.call` is not a string, so only the real `string` survives.
    expect(imported).toEqual([{ token: "string", foreground: "C3E88D" }]);
  });

  test("empty-tokencolors: build.ts's rules are all that remain", () => {
    const theme = convertFixture("empty-tokencolors.json");
    expect(theme.monaco.rules).toHaveLength(BUILTIN_RULE_COUNT);
    expect(theme.monaco.rules[0]).toEqual({ token: "", foreground: theme.tokens["fg.default"].slice(1) });
  });

  test("weird-name: the slug becomes the id while the trimmed name stays for display", () => {
    const theme = convertFixture("weird-name.json");
    expect(theme.id).toBe("ayu-mirage");
    expect(theme.name).toBe("Ayu  Mirage!!");
  });
});

describe("convertVsCodeTheme", () => {
  test("passes the theme's own colors through to Monaco, normalised (spec §9.3)", () => {
    const theme = ok(
      convertVsCodeTheme({
        name: "Alpha",
        type: "dark",
        colors: {
          "editor.background": "#1E1E1E",
          "editor.selectionBackground": "#264F7840",
          "editorCursor.foreground": "#FF00FF",
          "titleBar.activeBackground": "#0D0D0D",
          "editorGroup.border": "not a colour",
          "menu.selectionBackground": { nested: true },
        },
        tokenColors: [{ scope: "comment", settings: { foreground: "#6A9955" } }],
      }),
    );
    expect(theme.monaco.colors["editor.selectionBackground"]).toMatch(/^#[0-9A-F]{6}$/);
    expect(theme.monaco.colors["editor.background"]).toBe("#1E1E1E");
    // The theme's own value wins over build.ts's derivation, and a key build.ts never emits is added.
    expect(theme.monaco.colors["editorCursor.foreground"]).toBe("#FF00FF");
    expect(theme.tokens["fg.accent"]).not.toBe("#FF00FF");
    expect(theme.monaco.colors["titleBar.activeBackground"]).toBe("#0D0D0D");
    // A value that isn't a colour is dropped rather than handed to Monaco, which would reject the whole theme.
    expect(Object.keys(theme.monaco.colors)).not.toContain("editorGroup.border");
    expect(Object.keys(theme.monaco.colors)).not.toContain("menu.selectionBackground");
    expect(theme.monaco.rules).toContainEqual({ token: "comment", foreground: "6A9955" });
    // build.ts's own rules stay underneath, so a token the theme never styled still has a colour.
    expect(theme.monaco.rules[0]?.token).toBe("");
  });

  test("an alpha colour is composited over the theme's own canvas, not over black", () => {
    const theme = ok(
      convertVsCodeTheme({
        name: "Pale",
        type: "light",
        colors: { "editor.background": "#FFFFFF", "editor.selectionBackground": "#00000040" },
      }),
    );
    expect(theme.monaco.colors["editor.selectionBackground"]).toBe(mix("#FFFFFF", "#000000", 0x40 / 255));
    expect(theme.monaco.colors["editor.selectionBackground"]).not.toBe("#000000");
  });

  test("the theme's token colours reach the palette, not only the editor rules", () => {
    const base = { name: "Syntax", type: "dark", colors: { "editor.background": "#101010" } };
    const styled = ok(
      convertVsCodeTheme({
        ...base,
        tokenColors: [
          { scope: "comment", settings: { foreground: "#C3E88D" } },
          { scope: "entity.name.function", settings: { foreground: "#FFD166" } },
        ],
      }),
    );
    const bare = ok(convertVsCodeTheme(base));
    expect(styled.tokens["syntax.comment"]).toBe("#C3E88D");
    expect(bare.tokens["syntax.comment"]).not.toBe("#C3E88D");
    // `tag.function` is not in build.ts's Monaco vocabulary, so the `fn` palette slot is the only way an imported
    // function colour can arrive. Emitting the rule anyway would ship a rule Monaco's tokenizer never matches.
    expect(styled.tokens["syntax.function"]).toBe("#FFD166");
    expect(bare.tokens["syntax.function"]).not.toBe("#FFD166");
    expect(styled.monaco.rules.map((rule) => rule.token)).not.toContain("tag.function");
  });

  test("a declared type wins over the background, and a missing one is inferred from it", () => {
    const white = { "editor.background": "#FFFFFF" };
    expect(ok(convertVsCodeTheme({ name: "A", type: "dark", colors: white })).type).toBe("dark");
    expect(ok(convertVsCodeTheme({ name: "A", colors: white })).type).toBe("light");
    expect(ok(convertVsCodeTheme({ name: "A", colors: { "editor.background": "#101010" } })).type).toBe("dark");
  });

  test("invalid input produces a readable error and never throws (spec §9.3)", () => {
    const bad = [
      null,
      42,
      "a string",
      [],
      true,
      undefined,
      { colors: "not an object" },
      { colors: [] },
      { tokenColors: "nope" },
      { tokenColors: {} },
    ];
    for (const input of bad) {
      const result = convertVsCodeTheme(input);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected a failure");
      expect(result.error.length).toBeGreaterThan(0);
      expect(result.error).not.toMatch(/[/\\]|Error:|undefined/);
    }
  });

  test("the three refusals each name the part that is wrong", () => {
    const shape = refusal(convertVsCodeTheme(42));
    const colors = refusal(convertVsCodeTheme({ colors: 1 }));
    const tokens = refusal(convertVsCodeTheme({ tokenColors: 1 }));
    expect(new Set([shape, colors, tokens]).size).toBe(3);
    expect(colors).toContain("“colors”");
    expect(tokens).toContain("“tokenColors”");
  });

  test("a hostile but well-shaped theme still converts, and still meets AA", () => {
    const theme = ok(
      convertVsCodeTheme(
        {
          name: 42,
          type: [],
          colors: {
            "editor.background": {},
            "sideBar.background": "#FFFFFF",
            focusBorder: "rgb(1, 2, 3)",
            errorForeground: null,
            "editor.selectionBackground": "#GGGGGG",
          },
          tokenColors: [
            null,
            42,
            "comment",
            { scope: {} },
            { settings: null },
            { scope: ["keyword", 5], settings: { foreground: "inherit", fontStyle: 7 } },
            { scope: "string", settings: { foreground: "#C3E88D" } },
          ],
          semanticTokenColors: { variable: "#FFFFFF" },
          include: "./base.json",
        },
        { fallbackName: "hostile" },
      ),
    );
    expect(`${theme.name}/${theme.id}`).toBe("hostile/hostile");
    expect(aaFailures(theme)).toEqual([]);
    for (const name of TOKEN_NAMES) expect(`${name}=${theme.tokens[name]}`).toMatch(/=#[0-9A-F]{6}$/);
    expect(theme.monaco.rules).toContainEqual({ token: "string", foreground: "C3E88D" });
  });

  test("a theme with no colors and no tokenColors is still importable", () => {
    const theme = ok(convertVsCodeTheme({ name: "Bare" }));
    expect(theme.name).toBe("Bare");
    expect(theme.credit).toBe("Imported VS Code theme");
    expect(theme.id).toBe("bare");
    // With nothing to pass through, build.ts's own derived Monaco colours are what Monaco gets.
    expect(theme.monaco.colors["editor.background"]).toBe(theme.tokens["bg.canvas"]);
    expect(theme.monaco.rules).toHaveLength(BUILTIN_RULE_COUNT);
  });

  test("the display name falls back only when the theme has none of its own", () => {
    expect(ok(convertVsCodeTheme({ name: "  Bare  " })).name).toBe("Bare");
    expect(ok(convertVsCodeTheme({ name: "   " }, { fallbackName: "my-theme" })).name).toBe("my-theme");
    expect(ok(convertVsCodeTheme({ name: 42 }, { fallbackName: "  my-theme  " })).name).toBe("my-theme");
    expect(ok(convertVsCodeTheme({}, { fallbackName: "   " })).name).toBe("Imported Theme");
    expect(ok(convertVsCodeTheme({})).name).toBe("Imported Theme");
    expect(ok(convertVsCodeTheme({})).id).toBe("imported-theme");
  });
});

describe("the @jslab/themes barrel", () => {
  test("re-exports the VS Code converter and what it is built from, which is how Tasks 6-8 reach it", () => {
    expect(convertFromBarrel).toBe(convertVsCodeTheme);
    expect(monacoTokenForScope("entity.name.function")).toBe("tag.function");
    expect(normalizeHex("#abc", "#000000")).toBe("#AABBCC");
  });
});
