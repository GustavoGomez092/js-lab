import type { Settings } from "@jslab/shared";
import type { AppStore } from "../state/store";
import { strings } from "../strings";

export const DEFAULT_FONT = "JetBrains Mono";

/** Bundled coding fonts (spec §9.4): display name → CSS family registered by the font packages. */
export const BUNDLED_FONTS = [
  { name: "JetBrains Mono", family: "JetBrains Mono Variable" },
  { name: "Fira Code", family: "Fira Code" },
  { name: "DejaVu Sans Mono", family: "DejaVu Sans Mono" },
  { name: "Hack", family: "Hack" },
  { name: "Ubuntu Mono", family: "Ubuntu Mono" },
  { name: "Source Code Pro", family: "Source Code Pro" },
] as const;

export function isBundledFont(name: string): boolean {
  return BUNDLED_FONTS.some((font) => font.name === name);
}

export function fontFamily(name: string): string {
  return BUNDLED_FONTS.find((font) => font.name === name)?.family ?? name;
}

/**
 * None of the six bundled fonts (spec §9.4) carries a CJK glyph, and neither does `ui-monospace` or `Menlo`.
 * Without these, every Japanese and Chinese run in the UI falls through to last-resort substitution -- which
 * renders, so it is easy to miss, at metrics the stack was never tuned for. Naming them makes the line box
 * predictable. Hiragino Sans and PingFang SC ship with macOS, which is the only platform v1 targets (spec §2 D9).
 */
export const CJK_FALLBACK = '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "PingFang SC", "PingFang TC"';

export function fontStack(name: string): string {
  return `"${fontFamily(name).replaceAll('"', "")}", ${CJK_FALLBACK}, ui-monospace, Menlo, monospace`;
}

/** A font is available when it changes the measured width against at least one generic family. */
export function fontAvailable(family: string, measure: (font: string) => number): boolean {
  const quoted = `"${family.replaceAll('"', "")}"`;
  return (
    measure(`72px ${quoted}, monospace`) !== measure("72px monospace") ||
    measure(`72px ${quoted}, serif`) !== measure("72px serif")
  );
}

export async function checkFont(name: string): Promise<boolean> {
  const family = fontFamily(name);
  try {
    if (document.fonts) await document.fonts.load(`16px "${family}"`);
    const context = document.createElement("canvas").getContext("2d");
    if (!context) return true;
    const sample = "mmmmmmmmmmlli10OQ@#";
    return fontAvailable(family, (font) => {
      context.font = font;
      return context.measureText(sample).width;
    });
  } catch {
    return true;
  }
}

export function applyAppearanceVariables(root: HTMLElement, settings: Settings, fontFallback: boolean): void {
  const { appearance } = settings;
  root.style.setProperty("--ui-scale", String(appearance.uiScale));
  root.style.setProperty("--code-font-size", `${appearance.fontSize}px`);
  root.style.setProperty("--code-font-family", fontStack(fontFallback ? DEFAULT_FONT : appearance.font));
  root.style.setProperty("--code-ligatures", appearance.fontLigatures ? "normal" : "none");
}

/** Applies appearance variables and verifies the chosen font, falling back with a status notice (spec §9.4). */
export function startAppearanceSync(
  store: AppStore,
  root: HTMLElement,
  check: (font: string) => Promise<boolean> = checkFont,
): () => void {
  let disposed = false;
  let verified = "";
  // The fallback notice this sync itself last set, if any (fix round 1, m-1): remembered so a later successful
  // check can clear its own stale notice without also clearing an unrelated status message.
  let notice: string | null = null;

  const apply = () => {
    const state = store.getState();
    if (state.settings) applyAppearanceVariables(root, state.settings, state.fontFallback);
  };

  const verify = () => {
    const font = store.getState().settings?.appearance.font;
    if (!font || font === verified) return;
    verified = font;
    void check(font).then((available) => {
      if (disposed || store.getState().settings?.appearance.font !== font) return;
      store.getState().setFontFallback(!available);
      if (!available) {
        // m-2 (fix round 1): the default font can itself fail its check; don't claim to fall back to itself.
        notice = font === DEFAULT_FONT ? strings.fonts.bundledUnavailable : strings.fonts.fallback(font);
        // Sticky (FB-m5): the fallback lasts as long as the font is missing, and a later successful check clears it.
        store.getState().setStatusMessage(notice, { sticky: true });
      } else if (notice && store.getState().statusMessage === notice) {
        // m-1 (fix round 1): a later successful check clears its own stale fallback notice, but never an
        // unrelated status message that happens to be showing.
        store.getState().setStatusMessage(null);
        notice = null;
      }
      apply();
    });
  };

  apply();
  verify();
  const unsubscribe = store.subscribe((state, previous) => {
    const next = state.settings?.appearance;
    const prev = previous.settings?.appearance;
    // `mergeSettings` re-parses the whole settings object, so every `settings.changed` gets a new `appearance`
    // object even when only an unrelated section changed (same guard as startThemeSync in themes/apply.ts,
    // review R-M2-PF3 companion). Compare the appearance-affecting fields themselves, not object identity,
    // so an unrelated settings update (for example run.autoRun) doesn't reapply the CSS variables.
    const appearanceChanged =
      next !== prev &&
      (next?.font !== prev?.font ||
        next?.fontSize !== prev?.fontSize ||
        next?.fontLigatures !== prev?.fontLigatures ||
        next?.uiScale !== prev?.uiScale);
    if (appearanceChanged || state.fontFallback !== previous.fontFallback) {
      apply();
      verify();
    }
  });
  return () => {
    disposed = true;
    unsubscribe();
  };
}
