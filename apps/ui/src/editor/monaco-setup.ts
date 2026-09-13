import type { Language } from "@jslab/shared";
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import TsWorker from "monaco-editor/languages/features/typescript/ts.worker?worker";

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
  const compilerOptions: monaco.typescript.CompilerOptions = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    // TypeScript's ModuleResolutionKind.Bundler; Monaco's enum predates it.
    moduleResolution: 100 as monaco.typescript.ModuleResolutionKind,
    jsx: ts.JsxEmit.ReactJSX,
    strict: true,
    allowJs: true,
    checkJs: false,
    allowNonTsExtensions: true,
    esModuleInterop: true,
    allowSyntheticDefaultImports: true,
    skipLibCheck: true,
    // TypeScript's ModuleDetectionKind.Force, so top-level await is valid in every file.
    moduleDetection: 3,
    lib: ["esnext"],
  };
  for (const defaults of [ts.typescriptDefaults, ts.javascriptDefaults]) {
    defaults.setCompilerOptions(compilerOptions);
    defaults.setDiagnosticsOptions({
      noSemanticValidation: false,
      noSyntaxValidation: false,
      diagnosticCodesToIgnore: [1375, 1378],
    });
  }

  monaco.editor.defineTheme("jslab-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: { "editor.background": "#282A36", "editor.lineHighlightBackground": "#44475A55" },
  });
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
