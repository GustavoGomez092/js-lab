import type { ThemeDefinition } from "./build";

let registered: readonly ThemeDefinition[] = [];

/**
 * Replaces the whole set of imported themes (spec §9.3). Main loads `<appdata>/themes/` at startup and calls this in
 * both windows; a later import calls it again with the whole set, never a delta.
 *
 * Deliberately module-level state, mirroring the built-in index `index.ts` already keeps at module level: `listThemes`
 * and `getTheme` are plain functions called from four separate surfaces (Finding T1), and threading a registry object
 * through all of them would change four signatures to achieve the same thing.
 *
 * The set is copied, so a caller that keeps its own array and mutates it later cannot change what `getTheme` sees.
 */
export function registerUserThemes(themes: readonly ThemeDefinition[]): void {
  registered = [...themes];
}

/**
 * Every theme the last `registerUserThemes` call supplied — including one whose id a built-in already owns, which
 * `listThemes` and `getTheme` hide but which was still imported.
 */
export function userThemes(): readonly ThemeDefinition[] {
  return registered;
}
