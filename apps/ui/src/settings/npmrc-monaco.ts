import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import type { TextEditorLike } from "./NpmrcEditor";

/**
 * The Settings → NPM editor (spec §11.5): plain Monaco in ini mode, with only the editor worker (no TypeScript
 * worker), so this module is never loaded by unit tests — `NpmrcEditor` swaps it for a fake through `createEditor`.
 * Graphite theme parity and ⌘S (R27-6) are deferred to M5.
 */
export function createNpmrcMonaco(host: HTMLElement, value: string): TextEditorLike {
  self.MonacoEnvironment = { getWorker: () => new EditorWorker() };
  const editor = monaco.editor.create(host, {
    value,
    language: "ini",
    automaticLayout: true,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    fontSize: 13,
    lineNumbers: "on",
    theme: document.documentElement.dataset.themeType === "light" ? "vs" : "vs-dark",
  });
  return {
    getValue: () => editor.getValue(),
    setValue: (next) => editor.setValue(next),
    onChange: (listener) => {
      const subscription = editor.onDidChangeModelContent(listener);
      return () => subscription.dispose();
    },
    dispose: () => {
      editor.getModel()?.dispose();
      editor.dispose();
    },
  };
}
