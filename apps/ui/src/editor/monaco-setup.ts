import { DEFAULT_RUNTIME, type Language } from "@jslab/shared";
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import TsWorker from "monaco-editor/languages/features/typescript/ts.worker?worker";
import { compilerOptionsFor, diagnosticsOptionsFor } from "./ts-environment";

let configured = false;

/** One-time Monaco configuration (spec §6.1). Worker imports follow the M0-S2 report. */
export function setupMonaco(): typeof monaco {
  if (configured) return monaco;
  configured = true;

  self.MonacoEnvironment = {
    getWorker: (_workerId: string, label: string) =>
      label === "typescript" || label === "javascript" ? new TsWorker() : new EditorWorker(),
  };

  // The starting point before any tab is shown; Editor.tsx's TsEnvironment applies each shown tab's options (Task 21).
  const ts = monaco.typescript;
  for (const defaults of [ts.typescriptDefaults, ts.javascriptDefaults]) {
    defaults.setCompilerOptions(compilerOptionsFor(DEFAULT_RUNTIME, "2023-11") as monaco.typescript.CompilerOptions);
    defaults.setDiagnosticsOptions(diagnosticsOptionsFor(true));
  }

  return monaco;
}

const EXTENSIONS: Record<Language, string> = { typescript: "ts", tsx: "tsx", javascript: "js", jsx: "jsx" };

export function languageId(language: Language): "typescript" | "javascript" {
  return language === "typescript" || language === "tsx" ? "typescript" : "javascript";
}

/** The extension matters: the TypeScript worker only parses JSX in `.tsx`/`.jsx` models. */
export function modelUri(tabId: string, language: Language): string {
  return `file:///tab/${tabId}.${EXTENSIONS[language]}`;
}
