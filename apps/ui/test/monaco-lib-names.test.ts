import { describe, expect, test } from "bun:test";
import { DEFAULT_RUNTIME } from "@jslab/shared";
import { compilerOptionsFor, IGNORED_DIAGNOSTIC_CODES, libFor } from "../src/editor/ts-environment";
import { workerDiagnostics } from "./ts-worker";

// Monaco's own TypeScript worker is plain ESM (no DOM, no web worker), so this checks what the editor really reports
// with the editor's options, not just the option values.
const LIB_MODULE = "monaco-editor/languages/features/typescript/lib/lib.js";
const SLOW_MS = 30_000;

async function editorDiagnostics(fileName: string, source: string): Promise<string[]> {
  // DEFAULT_RUNTIME's options: the same values as PR #1's fixed editor options, with lib = libFor(DEFAULT_RUNTIME).
  const diagnostics = await workerDiagnostics({
    code: source,
    compilerOptions: compilerOptionsFor(DEFAULT_RUNTIME, "2023-11"),
    fileName,
  });
  return diagnostics
    .filter((diagnostic) => !IGNORED_DIAGNOSTIC_CODES.includes(diagnostic.code))
    .map((diagnostic) => `TS${diagnostic.code} ${diagnostic.message}`);
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
      for (const name of libFor(DEFAULT_RUNTIME)) expect(Object.hasOwn(libFileMap, name)).toBe(true);
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
