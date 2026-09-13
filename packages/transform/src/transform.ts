import * as Babel from "@babel/standalone";
import { createInstrumentPlugin } from "./instrument";
import type { Diagnostic, Language, RawSourceMap, TransformOptions, TransformResult } from "./types";

const FILENAMES: Record<Language, string> = {
  typescript: "entry.ts",
  tsx: "entry.tsx",
  javascript: "entry.js",
  jsx: "entry.jsx",
};

type Presets = NonNullable<NonNullable<Parameters<typeof Babel.transform>[1]>["presets"]>;

function presetsFor(language: Language): Presets {
  switch (language) {
    case "typescript":
      return [["typescript", {}]];
    case "tsx":
      return [
        ["typescript", {}],
        ["react", { runtime: "automatic" }],
      ];
    case "jsx":
      return [["react", { runtime: "automatic" }]];
    case "javascript":
      return [];
  }
}

export function transform(source: string, options: TransformOptions): TransformResult {
  const diagnostics: Diagnostic[] = [];
  const filename = FILENAMES[options.language];
  try {
    const out = Babel.transform(source, {
      filename,
      sourceType: "module",
      sourceMaps: true,
      presets: presetsFor(options.language),
      plugins: [createInstrumentPlugin(options, source, diagnostics)],
      parserOpts: { allowAwaitOutsideFunction: true },
    });
    if (!out) throw new Error("Babel returned no output");
    return { ok: true, code: out.code ?? "", map: out.map as RawSourceMap, diagnostics };
  } catch (error) {
    diagnostics.push(toDiagnostic(error));
    return { ok: false, diagnostics };
  }
}

interface BabelLikeError {
  message?: string;
  loc?: { line: number; column: number };
  jslabCode?: Diagnostic["code"];
}

export function toDiagnostic(error: unknown): Diagnostic {
  const e = error as BabelLikeError;
  const raw = String(e?.message ?? error);
  const [first = raw, ...rest] = raw.split("\n");
  const message = first.replace(/^.*?entry\.(?:tsx?|jsx?): /, "").replace(/ \(\d+:\d+\)$/, "");
  const codeFrame = rest.join("\n").trim();
  return {
    severity: "error",
    code: e?.jslabCode ?? "syntax",
    message,
    line: e?.loc?.line ?? 1,
    column: (e?.loc?.column ?? 0) + 1,
    ...(codeFrame ? { codeFrame } : {}),
  };
}
