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
  // Monaco's TypeScriptWorker gates suggestion diagnostics (for example TS6133, "declared but never read") behind
  // this flag separately from noSemanticValidation (languageFeatures.js DiagnosticsAdapter._doValidate); without
  // it, turning Linting off left suggestion-level markers on screen (Task 21 fix round 1, found via M-4(a)).
  noSuggestionDiagnostics: boolean;
  diagnosticCodesToIgnore: number[];
} {
  return {
    noSemanticValidation: !linting,
    noSyntaxValidation: !linting,
    noSuggestionDiagnostics: !linting,
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
  /**
   * Makes Monaco's global TypeScript defaults match the shown tab (spec §6.1).
   *
   * Rejects when a runtime pack fails to load. The options, diagnostics, package libs and local libs are still applied
   * without that pack, and the next `apply` retries the load. Callers catch and log the rejection.
   */
  apply(state: TsEnvironmentState): Promise<void>;
  setPackageFiles(name: string, files: readonly TypeFile[]): void;
  hasPackage(name: string): boolean;
  clearPackages(): void;
  setLocalFiles(tabId: string, files: readonly TypeFile[]): void;
  clearLocal(tabId?: string): void;
  /** A copy of the extra-lib paths last applied, each path once (E2E and tests). */
  libPaths(): string[];
  /**
   * Stops this environment from ever writing to `defaults` again (Task 21 fix round 1, M-2). A pending `apply`
   * still resolves once its pack load settles, but skips the sync and never rejects, even if the load failed;
   * every mutator becomes a no-op; `libPaths()` returns `[]`. Call this in the same effect cleanup that disposes
   * the editor's models, so an unmounted Editor's environment can never desynchronise a newer Editor's globals.
   */
  dispose(): void;
}

/** Two file lists are equal when they hold the same paths and contents in the same order. */
function sameFiles(a: readonly TypeFile[], b: readonly TypeFile[]): boolean {
  return (
    a.length === b.length &&
    a.every((file, index) => file.path === b[index]?.path && file.content === b[index]?.content)
  );
}

/**
 * A cheap content identity for the extra-lib key: the length plus a 32-bit FNV-1a hash of the UTF-16 code units.
 * Cached per file object, so a bundled pack is hashed once when it first applies, never on every sync.
 */
const fingerprints = new WeakMap<TypeFile, string>();
function fingerprintOf(file: TypeFile): string {
  let fingerprint = fingerprints.get(file);
  if (fingerprint === undefined) {
    let hash = 0x811c9dc5;
    for (let index = 0; index < file.content.length; index++) {
      hash ^= file.content.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    fingerprint = `${file.content.length}:${(hash >>> 0).toString(36)}`;
    fingerprints.set(file, fingerprint);
  }
  return fingerprint;
}

export function createTsEnvironment(deps: {
  defaults: readonly TsDefaultsLike[];
  loadPack(pack: RuntimePack): Promise<readonly TypeFile[]>;
}): TsEnvironment {
  const packs = new Map<RuntimePack, Promise<readonly TypeFile[]>>();
  const loadedPacks = new Map<RuntimePack, readonly TypeFile[]>();
  /** Packs whose load failed for the current state; they apply as empty until the next `apply` retries them. */
  const unavailablePacks = new Set<RuntimePack>();
  const packages = new Map<string, readonly TypeFile[]>();
  const local = new Map<string, readonly TypeFile[]>();
  let state: TsEnvironmentState | null = null;
  // null never equals a computed key, so the first sync sends all three values.
  let applied: { options: string; diagnostics: string; libs: string } | null = null;
  let appliedPaths: string[] = [];
  // Task 21 fix round 1, M-2: once true, sync/apply/every mutator becomes a no-op.
  let disposed = false;

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
    if (disposed || !state) return;
    const runtimePacks = packsFor(state.runtime);
    // A pack that is still loading holds the sync; a pack that failed for this state doesn't.
    if (!runtimePacks.every((pack) => loadedPacks.has(pack) || unavailablePacks.has(pack))) return;
    const options = compilerOptionsFor(state.runtime, state.decorators);
    const diagnostics = diagnosticsOptionsFor(state.linting);
    // One entry per path. Later sources win: runtime packs, then packages, then the shown tab's local files.
    const byPath = new Map<string, TypeFile>();
    for (const pack of runtimePacks) for (const file of loadedPacks.get(pack) ?? []) byPath.set(file.path, file);
    for (const files of packages.values()) for (const file of files) byPath.set(file.path, file);
    for (const file of (state.tabId ? local.get(state.tabId) : undefined) ?? []) byPath.set(file.path, file);
    const libs = [...byPath.values()];
    const next = {
      options: JSON.stringify(options),
      diagnostics: JSON.stringify(diagnostics),
      libs: libs.map((file) => `${file.path} ${fingerprintOf(file)}`).join(NEWLINE),
    };
    for (const defaults of deps.defaults) {
      if (next.options !== applied?.options) defaults.setCompilerOptions(options);
      if (next.diagnostics !== applied?.diagnostics) defaults.setDiagnosticsOptions(diagnostics);
      if (next.libs !== applied?.libs) {
        defaults.setExtraLibs(libs.map((file) => ({ content: file.content, filePath: file.path })));
      }
    }
    applied = next;
    appliedPaths = libs.map((file) => file.path);
  };

  return {
    async apply(next) {
      if (disposed) return;
      state = next;
      unavailablePacks.clear();
      const runtimePacks = packsFor(next.runtime);
      const results = await Promise.allSettled(runtimePacks.map(loadPack));
      // Disposed while this apply's pack load was in flight: resolve without applying, even if the load failed,
      // since nobody is listening any more (M-2).
      if (disposed) return;
      if (state === next) {
        results.forEach((result, index) => {
          const pack = runtimePacks[index];
          if (result.status === "rejected" && pack) unavailablePacks.add(pack);
        });
        sync();
      }
      const failure = results.find((result) => result.status === "rejected");
      if (failure) throw failure.reason;
    },
    setPackageFiles(name, files) {
      if (disposed) return;
      const previous = packages.get(name);
      packages.set(name, files);
      if (!previous || !sameFiles(previous, files)) sync();
    },
    hasPackage(name) {
      return !disposed && packages.has(name);
    },
    clearPackages() {
      if (disposed) return;
      const hadPackages = packages.size > 0;
      packages.clear();
      if (hadPackages) sync();
    },
    setLocalFiles(tabId, files) {
      if (disposed) return;
      const previous = local.get(tabId);
      local.set(tabId, files);
      if (tabId === state?.tabId && !(previous && sameFiles(previous, files))) sync();
    },
    clearLocal(tabId) {
      if (disposed) return;
      const shownTabId = state?.tabId ?? null;
      if (tabId === undefined) {
        const shownHadFiles = shownTabId !== null && local.has(shownTabId);
        local.clear();
        if (shownHadFiles) sync();
        return;
      }
      if (local.delete(tabId) && tabId === shownTabId) sync();
    },
    libPaths() {
      return disposed ? [] : [...appliedPaths];
    },
    dispose() {
      disposed = true;
    },
  };
}
