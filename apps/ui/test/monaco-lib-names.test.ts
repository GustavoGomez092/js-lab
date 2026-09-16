import { describe, expect, test } from "bun:test";
import { DEFAULT_RUNTIME } from "@jslab/shared";
import { compilerOptionsFor, IGNORED_DIAGNOSTIC_CODES, libFor } from "../src/editor/ts-environment";
import { workerDiagnostics } from "./ts-worker";

// Monaco's own TypeScript worker is plain ESM (no DOM, no web worker), so this checks what the editor really reports
// with the editor's options, not just the option values.
const LIB_MODULE = "monaco-editor/languages/features/typescript/lib/lib.js";
const SLOW_MS = 30_000;

/**
 * The runtime whose `lib` setting alone has to resolve the globals below.
 *
 * This harness sets `compilerOptions` and nothing else -- it does not install the `@types` packs `packsFor()` adds
 * in the real editor. That distinction did not matter while DEFAULT_RUNTIME was a DOM runtime, because `lib`
 * carried `console`/timers/`URL`/`fetch` on its own. M4 Task 9a pointed DEFAULT_RUNTIME back at "bun", whose libs
 * deliberately carry none of them: a Bun tab gets them from the `bun` and `node` packs instead, which
 * `ts-environment.test.ts` covers (`packsFor("bun")` → `["bun", "node"]`). So this test names the DOM runtime it
 * actually exercises rather than following the default and quietly testing a different thing.
 */
const DOM_RUNTIME = "browser-node" as const;

async function editorDiagnostics(fileName: string, source: string): Promise<string[]> {
  // The same values as PR #1's fixed editor options, with lib = libFor(DOM_RUNTIME).
  const diagnostics = await workerDiagnostics({
    code: source,
    compilerOptions: compilerOptionsFor(DOM_RUNTIME, "2023-11"),
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
