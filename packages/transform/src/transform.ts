import * as Babel from "@babel/standalone";
import { DEFAULT_BUILD_OPTIONS, proposalPlugins } from "./build";
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
      return [["typescript", { onlyRemoveTypeImports: false }]];
    case "tsx":
      return [
        ["typescript", { onlyRemoveTypeImports: false }],
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
      plugins: [
        createInstrumentPlugin(options, source, diagnostics),
        ...proposalPlugins(options.build ?? DEFAULT_BUILD_OPTIONS),
      ],
      parserOpts: { allowAwaitOutsideFunction: true },
    });
    if (!out) throw new Error("Babel returned no output");
    return { ok: true, code: out.code ?? "", map: out.map as RawSourceMap, diagnostics: capWarnings(diagnostics) };
  } catch (error) {
    diagnostics.push(toDiagnostic(error));
    return { ok: false, diagnostics: capWarnings(diagnostics) };
  }
}

/** Most warnings one transform reports (FA-m8): each becomes a run.diagnostics entry and a Monaco marker. */
export const MAX_WARNINGS = 500;

/**
 * Keeps every error and the first MAX_WARNINGS warnings, in order, then one warning that counts the rest (placed at
 * the first hidden warning). A source full of misplaced `//?` markers can't flood the UI with markers.
 */
export function capWarnings(diagnostics: Diagnostic[]): Diagnostic[] {
  const kept: Diagnostic[] = [];
  let warnings = 0;
  let firstHidden: Diagnostic | null = null;
  let hidden = 0;
  for (const diagnostic of diagnostics) {
    if (diagnostic.severity === "error" || warnings < MAX_WARNINGS) {
      if (diagnostic.severity === "warning") warnings++;
      kept.push(diagnostic);
      continue;
    }
    firstHidden ??= diagnostic;
    hidden++;
  }
  if (!firstHidden) return diagnostics;
  kept.push({
    severity: "warning",
    code: "too-many-warnings",
    message: `${hidden} more ${hidden === 1 ? "warning" : "warnings"} not shown`,
    line: firstHidden.line,
    column: firstHidden.column,
  });
  return kept;
}

interface BabelLikeError {
  message?: string;
  loc?: { line: number; column: number };
  jslabCode?: Diagnostic["code"];
}

/**
 * Diagnostic text is bounded where it is created (Task 18 fix round 1, I-1): Babel quotes whole source lines in its
 * code frame, so a syntax error on a very long line otherwise yields megabytes of text that freeze the UI.
 */
const MAX_MESSAGE_CHARS = 10_000;
const MAX_FRAME_CHARS = 10_000;
const MAX_FRAME_LINE_CHARS = 1_000;

/** At most `max` UTF-16 units plus an ellipsis, never cutting between the halves of a surrogate pair. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  return `${text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max)}…`;
}

export function toDiagnostic(error: unknown): Diagnostic {
  const e = error as BabelLikeError;
  const raw = String(e?.message ?? error);
  const [first = raw, ...rest] = raw.split("\n");
  const message = truncate(
    first.replace(/^.*?entry\.(?:tsx?|jsx?): /, "").replace(/ \(\d+:\d+\)$/, ""),
    MAX_MESSAGE_CHARS,
  );
  const codeFrame = truncate(
    rest
      .join("\n")
      .trim()
      .split("\n")
      .map((line) => truncate(line, MAX_FRAME_LINE_CHARS))
      .join("\n"),
    MAX_FRAME_CHARS,
  );
  return {
    severity: "error",
    code: e?.jslabCode ?? "syntax",
    message,
    line: e?.loc?.line ?? 1,
    column: (e?.loc?.column ?? 0) + 1,
    ...(codeFrame ? { codeFrame } : {}),
  };
}
