import { DEFAULT_DARK_THEME, DEFAULT_LIGHT_THEME } from "@jslab/shared";
import { buildTheme, type ThemeDefinition } from "./build";
import { THEME_INPUTS } from "./palettes";
import { userThemes } from "./user-themes";

export * from "./build";
export * from "./contrast";
export * from "./palettes";
export * from "./tokens";
export * from "./user-themes";
// The VS Code importer (spec §9.3). Tasks 6-8 reach `convertVsCodeTheme` and the two modules it is built from
// through this barrel, which is the only entry point `@jslab/themes` exposes.
export * from "./vscode/convert";
export * from "./vscode/derive";
export * from "./vscode/scopes";

// One source for the default theme ids: the settings defaults (Task 3) and theme resolution read the same constants.
export { DEFAULT_DARK_THEME, DEFAULT_LIGHT_THEME };

export const BUILTIN_THEMES: readonly ThemeDefinition[] = THEME_INPUTS.map(buildTheme);

export interface ThemeMeta {
  id: string;
  name: string;
  type: "dark" | "light";
}

const BUILTIN_BY_ID = new Map(BUILTIN_THEMES.map((theme) => [theme.id, theme]));

/**
 * The built-ins, then the themes imported from `<appdata>/themes/`. A built-in id is never shadowed, so a `.vsix`
 * that slugs to `graphite` cannot displace it; the registry is read on every call, so a theme imported while the app
 * is running is visible to the very next lookup, on all four surfaces of Finding T1.
 */
function themeIndex(): Map<string, ThemeDefinition> {
  const index = new Map(BUILTIN_BY_ID);
  for (const theme of userThemes()) if (!index.has(theme.id)) index.set(theme.id, theme);
  return index;
}

export function listThemes(): ThemeMeta[] {
  return [...themeIndex().values()].map(({ id, name, type }) => ({ id, name, type }));
}

export function getTheme(id: string): ThemeDefinition {
  return themeIndex().get(id) ?? (BUILTIN_BY_ID.get(DEFAULT_DARK_THEME) as ThemeDefinition);
}

/** `appearance.followSystem` picks the light/dark pair; unknown ids fall back to the Graphite pair (spec §8, §9). */
export function resolveThemeId(
  appearance: { theme: string; followSystem: boolean; lightTheme: string; darkTheme: string },
  systemDark: boolean,
): string {
  const index = themeIndex();
  if (!appearance.followSystem) return index.has(appearance.theme) ? appearance.theme : DEFAULT_DARK_THEME;
  if (systemDark) return index.has(appearance.darkTheme) ? appearance.darkTheme : DEFAULT_DARK_THEME;
  return index.has(appearance.lightTheme) ? appearance.lightTheme : DEFAULT_LIGHT_THEME;
}
