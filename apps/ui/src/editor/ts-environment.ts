import type { TypeFile } from "@jslab/rpc-schema";
import type { DecoratorMode, Runtime } from "@jslab/shared";

export type RuntimePack = "node" | "bun";

/** Spec §6.1: top-level await diagnostics are never shown. */
export const IGNORED_DIAGNOSTIC_CODES: readonly number[] = [1375, 1378];

// TypeScript enum values (Monaco's typings predate Bundler and ModuleDetectionKind).
const SCRIPT_TARGET_ESNEXT = 99;
const MODULE_ESNEXT = 99;
const MODULE_RESOLUTION_BUNDLER = 100;
const JSX_REACT_JSX = 4;
const MODULE_DETECTION_FORCE = 3;

/** Separates the entries of the applied extra-lib key. */
const NEWLINE = String.fromCharCode(10);

/**
 * Spec §5.2/§6.1: `bun` has no DOM; the browser runtimes do. Monaco's TypeScript worker uses every `lib` entry as a lib
 * FILE name, so these are full names, never tsconfig short names such as "dom" (PR #1: short names cause TS2584).
 */
export function libFor(runtime: Runtime): string[] {
  return runtime === "bun" ? ["lib.esnext.d.ts"] : ["lib.esnext.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"];
}

/** Spec §5.2 "Types fed to Monaco": bun → bun-types + @types/node; browser-node → @types/node; browser → none. */
export function packsFor(runtime: Runtime): RuntimePack[] {
  if (runtime === "bun") return ["bun", "node"];
  return runtime === "browser-node" ? ["node"] : [];
}

export function compilerOptionsFor(runtime: Runtime, decorators: DecoratorMode): Record<string, unknown> {
  return {
    target: SCRIPT_TARGET_ESNEXT,
    module: MODULE_ESNEXT,
    moduleResolution: MODULE_RESOLUTION_BUNDLER,
    jsx: JSX_REACT_JSX,
    strict: true,
    allowJs: true,
    checkJs: false,
    allowNonTsExtensions: true,
    esModuleInterop: true,
    allowSyntheticDefaultImports: true,
    experimentalDecorators: decorators === "legacy",
    moduleDetection: MODULE_DETECTION_FORCE,
    skipLibCheck: true,
    lib: libFor(runtime),
  };
}

export function diagnosticsOptionsFor(linting: boolean): {
  noSemanticValidation: boolean;
  noSyntaxValidation: boolean;
  diagnosticCodesToIgnore: number[];
} {
  return {
    noSemanticValidation: !linting,
    noSyntaxValidation: !linting,
    diagnosticCodesToIgnore: [...IGNORED_DIAGNOSTIC_CODES],
  };
}

/** The slice of `monaco.typescript.typescriptDefaults` this module drives; tests pass a fake. */
export interface TsDefaultsLike {
  setCompilerOptions(options: Record<string, unknown>): void;
  setDiagnosticsOptions(options: Record<string, unknown>): void;
  setExtraLibs(libs: { content: string; filePath?: string }[]): void;
}

export interface TsEnvironmentState {
  tabId: string | null;
  runtime: Runtime;
  decorators: DecoratorMode;
  linting: boolean;
}

export interface TsEnvironment {
  /** Makes Monaco's global TypeScript defaults match the shown tab (spec §6.1). */
  apply(state: TsEnvironmentState): Promise<void>;
  setPackageFiles(name: string, files: readonly TypeFile[]): void;
  hasPackage(name: string): boolean;
  clearPackages(): void;
  setLocalFiles(tabId: string, files: readonly TypeFile[]): void;
  clearLocal(tabId?: string): void;
  /** The extra-lib paths last applied (E2E and tests). */
  libPaths(): string[];
}

export function createTsEnvironment(deps: {
  defaults: readonly TsDefaultsLike[];
  loadPack(pack: RuntimePack): Promise<readonly TypeFile[]>;
}): TsEnvironment {
  const packs = new Map<RuntimePack, Promise<readonly TypeFile[]>>();
  const loadedPacks = new Map<RuntimePack, readonly TypeFile[]>();
  const packages = new Map<string, readonly TypeFile[]>();
  const local = new Map<string, readonly TypeFile[]>();
  let state: TsEnvironmentState | null = null;
  let applied = { options: "", diagnostics: "", libs: "" };
  let appliedPaths: string[] = [];
  let version = 0;

  const loadPack = (pack: RuntimePack) => {
    let entry = packs.get(pack);
    if (!entry) {
      entry = deps.loadPack(pack).then((files) => {
        loadedPacks.set(pack, files);
        return files;
      });
      packs.set(pack, entry);
      entry.catch(() => packs.delete(pack));
    }
    return entry;
  };

  const sync = () => {
    if (!state) return;
    const runtimePacks = packsFor(state.runtime);
    if (!runtimePacks.every((pack) => loadedPacks.has(pack))) return;
    const options = compilerOptionsFor(state.runtime, state.decorators);
    const diagnostics = diagnosticsOptionsFor(state.linting);
    const libs = [
      ...runtimePacks.flatMap((pack) => loadedPacks.get(pack) ?? []),
      ...[...packages.values()].flat(),
      ...(state.tabId ? (local.get(state.tabId) ?? []) : []),
    ];
    const next = {
      options: JSON.stringify(options),
      diagnostics: JSON.stringify(diagnostics),
      libs: [String(version), ...libs.map((file) => file.path)].join(NEWLINE),
    };
    for (const defaults of deps.defaults) {
      if (next.options !== applied.options) defaults.setCompilerOptions(options);
      if (next.diagnostics !== applied.diagnostics) defaults.setDiagnosticsOptions(diagnostics);
      if (next.libs !== applied.libs)
        defaults.setExtraLibs(libs.map((file) => ({ content: file.content, filePath: file.path })));
    }
    applied = next;
    appliedPaths = libs.map((file) => file.path);
  };

  return {
    async apply(next) {
      state = next;
      await Promise.all(packsFor(next.runtime).map(loadPack));
      if (state !== next) return;
      sync();
    },
    setPackageFiles(name, files) {
      packages.set(name, files);
      version++;
      sync();
    },
    hasPackage(name) {
      return packages.has(name);
    },
    clearPackages() {
      packages.clear();
      version++;
      sync();
    },
    setLocalFiles(tabId, files) {
      local.set(tabId, files);
      version++;
      sync();
    },
    clearLocal(tabId) {
      if (tabId === undefined) local.clear();
      else local.delete(tabId);
      version++;
      sync();
    },
    libPaths() {
      return appliedPaths;
    },
  };
}
