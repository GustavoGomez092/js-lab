import { describe, expect, test } from "bun:test";
import { EDITOR_COMPILER_OPTIONS, EDITOR_DIAGNOSTIC_CODES_TO_IGNORE, EDITOR_TS_LIB } from "../src/editor/ts-lib";

// Monaco's own TypeScript worker is plain ESM (no DOM, no web worker), so this checks what the editor really reports
// with the editor's options, not just the option values.
const WORKER_MODULE = "monaco-editor/languages/features/typescript/tsWorker.js";
const LIB_MODULE = "monaco-editor/languages/features/typescript/lib/lib.js";
const SLOW_MS = 30_000;

interface WorkerDiagnostic {
  code: number;
  messageText: string | { messageText: string };
}

interface WorkerLanguageService {
  getSyntacticDiagnostics(fileName: string): WorkerDiagnostic[];
  getSemanticDiagnostics(fileName: string): WorkerDiagnostic[];
}

type TypeScriptWorkerClass = new (
  ctx: { getMirrorModels(): unknown[] },
  createData: { compilerOptions: unknown; extraLibs: Record<string, unknown>; inlayHintsOptions: unknown },
) => { getLanguageService(): WorkerLanguageService };

async function editorDiagnostics(fileName: string, source: string): Promise<string[]> {
  const { TypeScriptWorker } = (await import(WORKER_MODULE)) as { TypeScriptWorker: TypeScriptWorkerClass };
  const model = {
    uri: { path: fileName.slice("file://".length), toString: () => fileName },
    version: 1,
    getValue: () => source,
  };
  const worker = new TypeScriptWorker(
    { getMirrorModels: () => [model] },
    { compilerOptions: { ...EDITOR_COMPILER_OPTIONS, lib: [...EDITOR_TS_LIB] }, extraLibs: {}, inlayHintsOptions: {} },
  );
  const service = worker.getLanguageService();
  return [...service.getSyntacticDiagnostics(fileName), ...service.getSemanticDiagnostics(fileName)]
    .filter((diagnostic) => !EDITOR_DIAGNOSTIC_CODES_TO_IGNORE.includes(diagnostic.code))
    .map((diagnostic) => {
      const text =
        typeof diagnostic.messageText === "string" ? diagnostic.messageText : diagnostic.messageText.messageText;
      return `TS${diagnostic.code} ${text}`;
    });
}

const SCRATCH = [
  'console.log("answer", 40 + 2);',
  "const timer = setTimeout(() => {}, 1);",
  "clearTimeout(timer);",
  'const url = new URL("https://example.com/docs");',
  "const seen = new Map([[url.pathname, true]]);",
  "for (const [path] of seen) console.info(path);",
  "await Promise.resolve(typeof fetch);",
  "",
].join("\n");

describe("editor TypeScript environment", () => {
  test(
    "every lib entry is a lib file Monaco bundles",
    async () => {
      const { libFileMap } = (await import(LIB_MODULE)) as { libFileMap: Record<string, string> };
      for (const name of EDITOR_TS_LIB) expect(Object.hasOwn(libFileMap, name)).toBe(true);
    },
    SLOW_MS,
  );

  test(
    "console, timers, URL and fetch type-check in TypeScript and TSX tabs",
    async () => {
      expect(await editorDiagnostics("file:///tab/scratch.ts", SCRATCH)).toEqual([]);
      expect(await editorDiagnostics("file:///tab/scratch.tsx", SCRATCH)).toEqual([]);
    },
    SLOW_MS,
  );
});
