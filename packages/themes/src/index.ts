import { DEFAULT_DARK_THEME, DEFAULT_LIGHT_THEME } from "@jslab/shared";
import { buildTheme, type ThemeDefinition } from "./build";
import { THEME_INPUTS } from "./palettes";

export * from "./build";
export * from "./contrast";
export * from "./palettes";
export * from "./tokens";

// One source for the default theme ids: the settings defaults (Task 3) and theme resolution read the same constants.
export { DEFAULT_DARK_THEME, DEFAULT_LIGHT_THEME };

export const BUILTIN_THEMES: readonly ThemeDefinition[] = THEME_INPUTS.map(buildTheme);

export interface ThemeMeta {
  id: string;
  name: string;
  type: "dark" | "light";
}

const BY_ID = new Map(BUILTIN_THEMES.map((theme) => [theme.id, theme]));

export function listThemes(): ThemeMeta[] {
  return BUILTIN_THEMES.map(({ id, name, type }) => ({ id, name, type }));
}

export function getTheme(id: string): ThemeDefinition {
  return BY_ID.get(id) ?? (BY_ID.get(DEFAULT_DARK_THEME) as ThemeDefinition);
}

/** `appearance.followSystem` picks the light/dark pair; unknown ids fall back to the Graphite pair (spec §8, §9). */
export function resolveThemeId(
  appearance: { theme: string; followSystem: boolean; lightTheme: string; darkTheme: string },
  systemDark: boolean,
): string {
  if (!appearance.followSystem) return BY_ID.has(appearance.theme) ? appearance.theme : DEFAULT_DARK_THEME;
  if (systemDark) return BY_ID.has(appearance.darkTheme) ? appearance.darkTheme : DEFAULT_DARK_THEME;
  return BY_ID.has(appearance.lightTheme) ? appearance.lightTheme : DEFAULT_LIGHT_THEME;
}
