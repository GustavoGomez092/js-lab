import type { Language } from "@jslab/shared";
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import TsWorker from "monaco-editor/languages/features/typescript/ts.worker?worker";
import { EDITOR_COMPILER_OPTIONS, EDITOR_DIAGNOSTIC_CODES_TO_IGNORE } from "./ts-lib";

let configured = false;

/** One-time Monaco configuration (spec §6.1). Worker imports follow the M0-S2 report. */
export function setupMonaco(): typeof monaco {
  if (configured) return monaco;
  configured = true;

  self.MonacoEnvironment = {
    getWorker: (_workerId: string, label: string) =>
      label === "typescript" || label === "javascript" ? new TsWorker() : new EditorWorker(),
  };

  const ts = monaco.typescript;
  const compilerOptions = {
    ...EDITOR_COMPILER_OPTIONS,
    lib: [...EDITOR_COMPILER_OPTIONS.lib],
  } as monaco.typescript.CompilerOptions;
  for (const defaults of [ts.typescriptDefaults, ts.javascriptDefaults]) {
    defaults.setCompilerOptions(compilerOptions);
    defaults.setDiagnosticsOptions({
      noSemanticValidation: false,
      noSyntaxValidation: false,
      diagnosticCodesToIgnore: [...EDITOR_DIAGNOSTIC_CODES_TO_IGNORE],
    });
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
