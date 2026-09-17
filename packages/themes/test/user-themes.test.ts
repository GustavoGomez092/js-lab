import { afterEach, describe, expect, test } from "bun:test";
import { convertVsCodeTheme, getTheme, listThemes, registerUserThemes, resolveThemeId, userThemes } from "../src";
import { buildTheme, type ThemeDefinition } from "../src/build";
import { userThemes as userThemesFromModule } from "../src/user-themes";

const make = (id: string, name: string, type: "dark" | "light" = "dark"): ThemeDefinition =>
  buildTheme({
    id,
    name,
    type,
    credit: "Imported VS Code theme",
    palette: {
      canvas: "#101010",
      chrome: "#0A0A0A",
      elevated: "#181818",
      border: "#2A2A2A",
      fg: "#E0E0E0",
      muted: "#909090",
      accent: "#6F9BFF",
      error: "#F07178",
      warn: "#E5C07B",
      success: "#5CC28A",
      info: "#7FD1C7",
      string: "#C3E88D",
      number: "#F5A97F",
      keyword: "#8FB4FF",
      fn: "#FFD580",
      type: "#7FD1C7",
      comment: "#6B7480",
      selection: "#2A3A5E",
      lineHighlight: "#181818",
    },
  });

const BUILTIN_COUNT = 21;
/** The pristine built-in order, captured before any test registers anything. */
const builtinIds = listThemes().map((theme) => theme.id);

afterEach(() => registerUserThemes([]));

describe("the user-theme registry", () => {
  test("starts empty and leaves the built-ins exactly as they were", () => {
    expect(userThemes()).toEqual([]);
    expect(listThemes()).toHaveLength(BUILTIN_COUNT);
    expect(getTheme("graphite").id).toBe("graphite");
  });

  test("a registered theme is listed after the built-ins and is retrievable by id", () => {
    registerUserThemes([make("dracula-pro", "Dracula Pro")]);
    const all = listThemes();
    expect(all).toHaveLength(BUILTIN_COUNT + 1);
    // The built-ins keep their identity and their order: themes.test.ts's `slice(0, 2)` depends on it.
    expect(all.slice(0, BUILTIN_COUNT).map((theme) => theme.id)).toEqual(builtinIds);
    expect(all[BUILTIN_COUNT]).toEqual({ id: "dracula-pro", name: "Dracula Pro", type: "dark" });
    expect(getTheme("dracula-pro").name).toBe("Dracula Pro");
  });

  test("a converted VS Code theme arrives whole, not reduced to its metadata", () => {
    const converted = convertVsCodeTheme({
      name: "Dracula Pro",
      type: "dark",
      colors: { "editor.background": "#22212C" },
      tokenColors: [{ scope: "comment", settings: { foreground: "#7B7F8B" } }],
    });
    expect(converted.ok).toBe(true);
    if (!converted.ok) throw new Error(converted.error);
    registerUserThemes([converted.theme]);
    // Monaco is handed `getTheme(id).monaco` (Editor.tsx:99), so the registry must hand back the very object it
    // was given — not a copy, and not a `ThemeMeta` widened back out.
    expect(getTheme("dracula-pro")).toBe(converted.theme);
    expect(getTheme("dracula-pro").monaco.colors["editor.background"]).toBe("#22212C");
    expect(getTheme("dracula-pro").tokens["bg.canvas"]).toMatch(/^#[0-9A-F]{6}$/);
  });

  test("imported themes keep the order they were registered in, with their own name and type", () => {
    registerUserThemes([make("zulu", "Zulu"), make("alpha", "Alpha", "light")]);
    // Not alphabetical, and not both dark: this pins the order and the `type` passthrough the Appearance picker
    // groups by (SettingsApp.tsx:322) at the same time.
    expect(listThemes().slice(BUILTIN_COUNT)).toEqual([
      { id: "zulu", name: "Zulu", type: "dark" },
      { id: "alpha", name: "Alpha", type: "light" },
    ]);
    expect(userThemes().map((theme) => theme.id)).toEqual(["zulu", "alpha"]);
  });

  test("registering replaces the previous set rather than accumulating", () => {
    registerUserThemes([make("one", "One")]);
    registerUserThemes([make("two", "Two")]);
    expect(listThemes().map((theme) => theme.id)).not.toContain("one");
    expect(getTheme("one").id).toBe("graphite");
    expect(getTheme("two").id).toBe("two");
  });

  test("registering an empty set clears the registry and restores the built-ins exactly", () => {
    registerUserThemes([make("gone", "Gone")]);
    registerUserThemes([]);
    expect(userThemes()).toEqual([]);
    // Also proves the merge never writes into the built-in index: a leaked entry would survive the clear.
    expect(listThemes().map((theme) => theme.id)).toEqual(builtinIds);
    expect(getTheme("gone").id).toBe("graphite");
  });

  test("the set is copied on the way in, so a later mutation by the caller cannot change it", () => {
    const supplied = [make("first", "First")];
    registerUserThemes(supplied);
    supplied.push(make("smuggled", "Smuggled"));
    expect(userThemes().map((theme) => theme.id)).toEqual(["first"]);
    expect(listThemes()).toHaveLength(BUILTIN_COUNT + 1);
    expect(getTheme("smuggled").id).toBe("graphite");
  });

  test("a built-in id can never be shadowed by an imported theme", () => {
    const nord = getTheme("nord");
    expect(nord.id).toBe("nord");
    registerUserThemes([make("graphite", "Not Graphite"), make("nord", "Not Nord", "light")]);
    expect(getTheme("graphite").name).toBe("Graphite");
    expect(getTheme("nord")).toBe(nord);
    expect(listThemes().map((theme) => theme.id)).toEqual(builtinIds);
    // The shadowed themes are still reported as registered; `listThemes` is the only surface that hides them.
    expect(userThemes()).toHaveLength(2);
  });

  test("within the imported set, the first theme claiming an id wins", () => {
    registerUserThemes([make("dup", "First"), make("dup", "Second")]);
    expect(listThemes().filter((theme) => theme.id === "dup")).toHaveLength(1);
    expect(listThemes()[BUILTIN_COUNT]).toEqual({ id: "dup", name: "First", type: "dark" });
    expect(getTheme("dup").name).toBe("First");
  });

  // Finding T2: without this, choosing an imported theme silently reverts to Graphite and looks like a failed import.
  test("resolveThemeId accepts an imported id, for the direct and the follow-system paths", () => {
    registerUserThemes([make("nord-light", "Nord Light", "light"), make("nord-deep", "Nord Deep")]);
    const direct = { theme: "nord-deep", followSystem: false, lightTheme: "x", darkTheme: "y" };
    const follow = { theme: "x", followSystem: true, lightTheme: "nord-light", darkTheme: "nord-deep" };
    expect(resolveThemeId(direct, true)).toBe("nord-deep");
    expect(resolveThemeId(follow, false)).toBe("nord-light");
    expect(resolveThemeId(follow, true)).toBe("nord-deep");
    expect(resolveThemeId({ ...direct, theme: "gone" }, true)).toBe("graphite");
    expect(resolveThemeId({ ...follow, lightTheme: "gone" }, false)).toBe("graphite-light");
  });

  test("resolveThemeId reads the registry live, so a cleared id falls back again", () => {
    registerUserThemes([make("nord-deep", "Nord Deep")]);
    const direct = { theme: "nord-deep", followSystem: false, lightTheme: "x", darkTheme: "y" };
    const follow = { theme: "x", followSystem: true, lightTheme: "y", darkTheme: "nord-deep" };
    expect(resolveThemeId(direct, true)).toBe("nord-deep");
    expect(resolveThemeId(follow, true)).toBe("nord-deep");
    registerUserThemes([]);
    expect(resolveThemeId(direct, true)).toBe("graphite");
    expect(resolveThemeId(follow, true)).toBe("graphite");
  });

  test("the barrel and the module itself share one registry", () => {
    // Writes through the barrel must be visible through the module, or `@jslab/themes` would hand Main and the UI
    // two registries. Asserted by observing a write, not by array identity, so hardening `userThemes` to copy its
    // result out would not break this.
    registerUserThemes([make("shared", "Shared")]);
    expect(userThemesFromModule().map((theme) => theme.id)).toEqual(["shared"]);
    registerUserThemes([]);
    expect(userThemesFromModule()).toEqual([]);
  });
});
