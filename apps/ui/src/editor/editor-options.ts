import type { Settings } from "@jslab/shared";
import { DEFAULT_FONT, fontStack } from "../themes/fonts";

/** The subset of Monaco IEditorOptions driven by settings (spec §8 Editor and Appearance). */
export interface EditorOptions {
  fontFamily: string;
  fontSize: number;
  fontLigatures: boolean;
  lineNumbers: "on" | "off";
  wordWrap: "on" | "off";
  autoClosingBrackets: "languageDefined" | "never";
  autoClosingQuotes: "languageDefined" | "never";
  renderWhitespace: "all" | "none";
  renderLineHighlight: "all" | "none";
  minimap: { enabled: boolean };
  quickSuggestions: boolean;
  suggestOnTriggerCharacters: boolean;
  hover: { enabled: boolean; delay: number };
  parameterHints: { enabled: boolean };
  /**
   * User report (M4): line 1 sat flush against the bottom edge of the active tab, with no breathing room.
   *
   * Monaco's own option, deliberately not CSS on `.editor`: Monaco owns that scroll region and computes line
   * positions from its own content height, so container padding fights its layout instead of insetting it.
   */
  padding: { top: number; bottom: number };
}

/**
 * The shell's standing inset, in CSS px at 100% zoom -- `.output-toolbar` uses `padding: 0 12px` and `.entry`
 * `5px 12px` (`styles.css`). Reused vertically here so the first line clears the tab bar (`--tabbar-height`) by
 * the same gap every other region's content clears its own edges by, rather than by a number invented for Monaco.
 */
const EDITOR_PADDING = 12;

export function editorOptionsFor(settings: Settings, fontFallback = false): EditorOptions {
  const { editor, appearance } = settings;
  const brackets = editor.closeBrackets ? "languageDefined" : "never";
  return {
    fontFamily: fontStack(fontFallback ? DEFAULT_FONT : appearance.font),
    fontSize: Math.round(appearance.fontSize * appearance.uiScale),
    fontLigatures: appearance.fontLigatures,
    lineNumbers: editor.lineNumbers ? "on" : "off",
    wordWrap: editor.lineWrap ? "on" : "off",
    autoClosingBrackets: brackets,
    autoClosingQuotes: brackets,
    renderWhitespace: editor.invisibles ? "all" : "none",
    renderLineHighlight: editor.activeLine ? "all" : "none",
    minimap: { enabled: editor.minimap },
    quickSuggestions: editor.autocomplete,
    suggestOnTriggerCharacters: editor.autocomplete,
    hover: { enabled: editor.hoverInfo, delay: editor.hoverDelayMs },
    parameterHints: { enabled: editor.signatures },
    // Scaled here rather than in CSS: `--tabbar-height` and friends are `calc(... * var(--ui-scale))`, but Monaco's
    // `padding` is a plain number it measures itself, with no way to read a CSS variable. Rounded and multiplied
    // exactly like `fontSize` above, so zoom moves the inset and the text together.
    padding: {
      top: Math.round(EDITOR_PADDING * appearance.uiScale),
      bottom: Math.round(EDITOR_PADDING * appearance.uiScale),
    },
  };
}
