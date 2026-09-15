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
}

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
  };
}
