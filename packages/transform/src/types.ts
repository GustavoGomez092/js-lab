export type Language = "typescript" | "javascript" | "tsx" | "jsx";

/** `build.decorators` (spec §8 Build). */
export type DecoratorMode = "none" | "2023-11" | "legacy";

/** The Build tab (spec §8): the syntax proposals the transform enables. */
export interface BuildOptions {
  decorators: DecoratorMode;
  pipelineOperator: boolean;
  doExpressions: boolean;
  throwExpressions: boolean;
  functionSent: boolean;
  regexpModifiers: boolean;
  optionalChainingAssign: boolean;
}

/** A tab's working directory (spec §5.3): `dir` is the WD, `filename` is `<WD>/<script name>`. */
export interface WorkingDirectoryOptions {
  dir: string;
  filename: string;
}

export interface TransformOptions {
  language: Language;
  autoLog: boolean;
  loopProtection: boolean;
  loopProtectionMaxIterations: number;
  logpoints: readonly number[];
  /** Defaults to DEFAULT_BUILD_OPTIONS (the spec §8 defaults). */
  build?: BuildOptions;
  workingDirectory?: WorkingDirectoryOptions;
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
