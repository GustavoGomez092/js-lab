import type { TypeFile } from "@jslab/rpc-schema";
import { typescript } from "monaco-editor/languages/features/typescript/lib/typescriptServices";
import { TypeScriptWorker } from "monaco-editor/languages/features/typescript/tsWorker";

export interface WorkerDiagnostic {
  code: number;
  message: string;
}

/** The newline TypeScript joins chained diagnostic messages with. */
const NEWLINE = String.fromCharCode(10);

/**
 * Monaco's real TypeScriptWorker, constructed in-process under `bun test` (no web worker): one model plus extra libs,
 * with the editor's compiler options. It resolves `lib` entries against Monaco's bundled lib files exactly as the
 * running editor does.
 */
export async function workerDiagnostics(input: {
  code: string;
  compilerOptions: Record<string, unknown>;
  extraLibs?: readonly TypeFile[];
  fileName?: string;
}): Promise<WorkerDiagnostic[]> {
  const fileName = input.fileName ?? "file:///tab/t1.ts";
  const model = {
    uri: { path: new URL(fileName).pathname, toString: () => fileName },
    version: 1,
    getValue: () => input.code,
  };
  const extraLibs = Object.fromEntries(
    (input.extraLibs ?? []).map((file) => [file.path, { content: file.content, version: 1 }]),
  );
  const worker = new TypeScriptWorker(
    { getMirrorModels: () => [model] },
    { compilerOptions: input.compilerOptions, extraLibs },
  );
  const diagnostics = [
    ...(await worker.getSyntacticDiagnostics(fileName)),
    ...(await worker.getSemanticDiagnostics(fileName)),
  ];
  return diagnostics.map((diagnostic) => ({
    code: diagnostic.code,
    message: typescript.flattenDiagnosticMessageText(diagnostic.messageText, NEWLINE) as string,
  }));
}
