// Monaco ships its TypeScript worker and services without typings; tests run them in-process to check the editor's
// compiler options. If the M3 base (PR #1) already declares these modules, keep one declaration of each.
declare module "monaco-editor/languages/features/typescript/lib/typescriptServices" {
  // biome-ignore lint/suspicious/noExplicitAny: untyped bundled TypeScript
  export const typescript: any;
}
declare module "monaco-editor/languages/features/typescript/tsWorker" {
  export interface MirrorModelLike {
    uri: { path: string; toString(skipEncoding?: boolean): string };
    version: number;
    getValue(): string;
  }
  export interface WorkerDiagnosticLike {
    code: number;
    messageText: unknown;
  }
  export class TypeScriptWorker {
    constructor(
      ctx: { getMirrorModels(): MirrorModelLike[] },
      createData: {
        compilerOptions: Record<string, unknown>;
        extraLibs: Record<string, { content: string; version: number }>;
      },
    );
    getSyntacticDiagnostics(fileName: string): Promise<WorkerDiagnosticLike[]>;
    getSemanticDiagnostics(fileName: string): Promise<WorkerDiagnosticLike[]>;
  }
}
