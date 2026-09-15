/**
 * TypeScript configuration for every editor model (spec §6.1). M3's per-runtime type environment replaces the single
 * `lib` list with per-runtime libs plus bundled bun-types/@types/node.
 *
 * `lib` lists full lib FILE names. Monaco hands `compilerOptions.lib` straight to the TypeScript language service,
 * which only maps tsconfig short names (`dom`) when it parses a tsconfig. With short names the DOM lib never loads,
 * so `console`, timers and `URL` show as errors in the editor.
 */
export const EDITOR_TS_LIB: readonly string[] = ["lib.esnext.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"];

/**
 * Compiler options as plain values (Monaco's enums are numbers), so tests can check the real TypeScript worker with
 * exactly these options without loading the editor.
 */
export const EDITOR_COMPILER_OPTIONS = {
  target: 99, // ScriptTarget.ESNext
  module: 99, // ModuleKind.ESNext
  moduleResolution: 100, // ModuleResolutionKind.Bundler; Monaco's enum predates it
  jsx: 4, // JsxEmit.ReactJSX
  strict: true,
  allowJs: true,
  checkJs: false,
  allowNonTsExtensions: true,
  esModuleInterop: true,
  allowSyntheticDefaultImports: true,
  skipLibCheck: true,
  moduleDetection: 3, // ModuleDetectionKind.Force, so top-level await is valid in every file
  lib: [...EDITOR_TS_LIB],
};

/** Top-level await diagnostics (TS1375, TS1378) don't apply: every file runs as a module. */
export const EDITOR_DIAGNOSTIC_CODES_TO_IGNORE: readonly number[] = [1375, 1378];
