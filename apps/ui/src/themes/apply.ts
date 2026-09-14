import { getTheme, resolveThemeId, type ThemeDefinition, toCssVariables } from "@jslab/themes";
import type { AppStore } from "../state/store";

export function applyThemeVariables(theme: ThemeDefinition, root: HTMLElement): void {
  for (const [name, value] of Object.entries(toCssVariables(theme.tokens))) root.style.setProperty(name, value);
  root.style.colorScheme = theme.type;
  root.dataset.theme = theme.id;
}

interface MediaLike {
  matches: boolean;
  addEventListener(type: "change", listener: () => void): void;
  removeEventListener(type: "change", listener: () => void): void;
}

export interface ThemeSyncOptions {
  root: HTMLElement;
  /** `window.matchMedia("(prefers-color-scheme: dark)")`, or null where unavailable. */
  media: MediaLike | null;
}

/** Keeps CSS variables and `store.themeId` in step with settings and the macOS appearance (spec §9). */
export function startThemeSync(store: AppStore, options: ThemeSyncOptions): () => void {
  const apply = () => {
    const settings = store.getState().settings;
    if (!settings) return;
    const theme = getTheme(resolveThemeId(settings.appearance, options.media?.matches ?? true));
    applyThemeVariables(theme, options.root);
    store.getState().setThemeId(theme.id);
  };
  const onSystemChange = () => {
    if (store.getState().settings?.appearance.followSystem) apply();
  };
  apply();
  options.media?.addEventListener("change", onSystemChange);
  const unsubscribe = store.subscribe((state, previous) => {
    if (state.settings?.appearance !== previous.settings?.appearance) apply();
  });
  return () => {
    unsubscribe();
    options.media?.removeEventListener("change", onSystemChange);
  };
}
