export type Language = "typescript" | "javascript" | "tsx" | "jsx";

export interface TransformOptions {
  language: Language;
  autoLog: boolean;
  loopProtection: boolean;
  loopProtectionMaxIterations: number;
  logpoints: readonly number[];
}

export type DiagnosticCode =
  | "syntax"
  | "reserved-identifier"
  | "magic-comment-no-value"
  | "magic-comment-invalid-expression"
  | "logpoint-no-value"
  | "too-many-warnings";

export interface Diagnostic {
  severity: "error" | "warning";
  code: DiagnosticCode;
  message: string;
  line: number;
  column: number;
  codeFrame?: string;
}

export interface RawSourceMap {
  version: number;
  sources: string[];
  names: string[];
  mappings: string;
  sourcesContent?: string[];
  file?: string;
}

export type TransformResult =
  | { ok: true; code: string; map: RawSourceMap; diagnostics: Diagnostic[] }
  | { ok: false; diagnostics: Diagnostic[] };
