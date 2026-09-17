import { packageNameFromSpecifier } from "@jslab/npm/specifiers";
import {
  type LocalTypesResult,
  MAX_LOCAL_SPECIFIERS_PER_REQUEST,
  MAX_PACKAGE_NAME_CHARS,
  MAX_PACKAGES_PER_REQUEST,
  type PackageTypesResult,
} from "@jslab/rpc-schema";
import type { TimerApi } from "../state/auto-run";
import type { TsEnvironment } from "./ts-environment";

/** Spec §6.2: the UI requests types for the imports in a model, debounced 500 ms. */
export const TYPE_FEED_DELAY_MS = 500;

// The three request limits this module applies (`MAX_PACKAGES_PER_REQUEST`, `MAX_PACKAGE_NAME_CHARS` and
// `MAX_LOCAL_SPECIFIERS_PER_REQUEST`) are imported from `@jslab/rpc-schema`, which is the side that enforces
// them. They used to be re-declared here as bare literals that happened to agree; on drift Main would reject the
// request with InvalidPayloadError, and the catch below only logs -- so type hints would silently stop appearing.

/**
 * Above this many characters, only the first `MAX_IMPORT_SCAN_CHARS` of the buffer are scanned for imports (Task 23
 * fix round 2, I-4). Imports live at the top of a file, so scanning the whole buffer of a huge, mostly blank or
 * mostly-data file on every debounce is needless work.
 */
export const IMPORT_SCAN_LIMIT = 2_000_000;
export const MAX_IMPORT_SCAN_CHARS = 200_000;

const PATTERNS = [
  /\bfrom\s*["']([^"'\n]+)["']/g,
  /\bimport\s*\(\s*["']([^"'\n]+)["']\s*\)/g,
  /\brequire\s*\(\s*["']([^"'\n]+)["']\s*\)/g,
  // I-4: `[ \t]*`, never `\s*`, directly after `^` under the `m` flag. `\s*` also matches newlines, so with `m` every
  // line start is a candidate whose `\s*` can consume (and then backtrack across) the whole remaining blank-line
  // run: quadratic on a buffer with many blank or whitespace-only lines.
  /^[ \t]*import\s*["']([^"'\n]+)["']/gm,
];

export function importSpecifiers(code: string): { packages: string[]; relative: string[] } {
  const text = code.length > IMPORT_SCAN_LIMIT ? code.slice(0, MAX_IMPORT_SCAN_CHARS) : code;
  const packages = new Set<string>();
  const relative = new Set<string>();
  for (const pattern of PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const specifier = match[1] as string;
      if (specifier.startsWith("./") || specifier.startsWith("../")) relative.add(specifier);
      else {
        const name = packageNameFromSpecifier(specifier);
        if (name) packages.add(name);
      }
    }
  }
  return { packages: [...packages].sort(), relative: [...relative].sort() };
}

export interface TypeFeederDeps {
  requestPackages(tabId: string, names: string[]): Promise<PackageTypesResult[]>;
  requestLocal(tabId: string, specifiers: string[]): Promise<LocalTypesResult>;
  environment: Pick<TsEnvironment, "setPackageFiles" | "clearPackages" | "setLocalFiles" | "clearLocal">;
  timers?: TimerApi;
  delayMs?: number;
  log?(message: string, detail?: unknown): void;
}

export interface TypeFeeder {
  /**
   * Debounced by default. `{ immediate: true }` cancels any pending timer for this tab and feeds right away
   * (Task 23 fix round 2, I-1) — used for a working-directory change or a tab switch, where waiting out the debounce
   * would show false "Cannot find module" markers for imports that already resolved a moment ago.
   */
  schedule(tabId: string, code: string, hasWorkingDirectory: boolean, options?: { immediate?: boolean }): void;
  /** Installed packages without types, with the @types package to offer (or null). */
  untyped(): ReadonlyMap<string, string | null>;
  invalidatePackages(): void;
  invalidateLocal(tabId: string): void;
  /** Releases a closed tab: cancels its pending feed and clears its local files (Task 23 fix round 2, M-1). */
  forget(tabId: string): void;
  dispose(): void;
}

const defaultTimers: TimerApi = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createTypeFeeder(deps: TypeFeederDeps): TypeFeeder {
  const timers = deps.timers ?? defaultTimers;
  const requested = new Set<string>();
  const untyped = new Map<string, string | null>();
  const scheduled = new Map<string, unknown>();
  // Task 23 fix round 2, I-2: bumped at the start of every feed for a tab (and by invalidateLocal/forget), so a
  // response from an earlier feed for the same tab is dropped, not applied over a newer one's.
  const localGeneration = new Map<string, number>();
  let generation = 0;
  // Task 23 fix round 2, I-1 "replace, don't clear first": invalidatePackages() defers clearing the environment's
  // packages until the first result of the new generation is about to be applied (or the request comes back empty,
  // or fails), so the environment never syncs an empty package set in between and never shows false 2307s.
  let clearPending = false;
  let disposed = false;

  const bumpLocalGeneration = (tabId: string): number => {
    const next = (localGeneration.get(tabId) ?? 0) + 1;
    localGeneration.set(tabId, next);
    return next;
  };

  const resolveClear = () => {
    if (!clearPending) return;
    clearPending = false;
    deps.environment.clearPackages();
  };

  const requestPackages = async (tabId: string, names: readonly string[]): Promise<void> => {
    if (disposed) return;
    const fresh = [...new Set(names)].filter((name) => !requested.has(name) && name.length <= MAX_PACKAGE_NAME_CHARS);
    if (fresh.length === 0) {
      resolveClear();
      return;
    }
    const startedGeneration = generation;
    for (let index = 0; index < fresh.length; index += MAX_PACKAGES_PER_REQUEST) {
      if (disposed || startedGeneration !== generation) return;
      const chunk = fresh.slice(index, index + MAX_PACKAGES_PER_REQUEST);
      for (const name of chunk) requested.add(name);
      let results: PackageTypesResult[];
      try {
        results = await deps.requestPackages(tabId, chunk);
      } catch (error) {
        if (disposed) return;
        // M-3: a stale generation's failure never undoes a newer generation's marks (which may already be in
        // flight again under the current generation).
        if (startedGeneration === generation) for (const name of chunk) requested.delete(name);
        deps.log?.("Couldn't load package types", String(error));
        resolveClear();
        continue;
      }
      if (disposed) return;
      if (startedGeneration !== generation) return;
      resolveClear();
      const dependencies: string[] = [];
      for (const entry of results) {
        if (entry.files.length > 0) deps.environment.setPackageFiles(entry.name, entry.files);
        // Only an installed package without types names an @types package (Task 13). A package that isn't installed
        // (typesPackage null) keeps "Install package x" from its 2307 marker instead of offering @types/x.
        if (!entry.hasTypes && entry.typesPackage !== null) untyped.set(entry.name, entry.typesPackage);
        else untyped.delete(entry.name);
        if (entry.truncated) deps.log?.("type results truncated", { tabId, name: entry.name });
        dependencies.push(...entry.dependencies);
      }
      if (dependencies.length > 0) await requestPackages(tabId, dependencies);
    }
  };

  const feed = async (tabId: string, code: string, hasWorkingDirectory: boolean) => {
    if (disposed) return;
    const myLocalGeneration = bumpLocalGeneration(tabId);
    const { packages, relative } = importSpecifiers(code);
    if (!hasWorkingDirectory) {
      deps.environment.clearLocal(tabId);
      await requestPackages(tabId, packages);
      return;
    }
    let localPackages: string[] = [];
    if (relative.length > 0) {
      try {
        const local = await deps.requestLocal(tabId, relative.slice(0, MAX_LOCAL_SPECIFIERS_PER_REQUEST));
        if (disposed) return;
        // I-2: a response from an earlier feed for this tab is dropped whole, including its packages, rather than
        // overwriting the newer working directory's files.
        if (localGeneration.get(tabId) === myLocalGeneration) {
          deps.environment.setLocalFiles(tabId, local.files);
          if (local.truncated) deps.log?.("type results truncated", { tabId, name: "local" });
          localPackages = local.packages;
        }
      } catch (error) {
        if (disposed) return;
        deps.log?.("Couldn't load working-directory types", String(error));
      }
    }
    if (disposed) return;
    await requestPackages(tabId, [...packages, ...localPackages]);
  };

  return {
    schedule(tabId, code, hasWorkingDirectory, options) {
      if (disposed) return;
      const existing = scheduled.get(tabId);
      if (existing !== undefined) {
        timers.clearTimeout(existing);
        scheduled.delete(tabId);
      }
      if (options?.immediate) {
        void feed(tabId, code, hasWorkingDirectory);
        return;
      }
      scheduled.set(
        tabId,
        timers.setTimeout(() => {
          scheduled.delete(tabId);
          void feed(tabId, code, hasWorkingDirectory);
        }, deps.delayMs ?? TYPE_FEED_DELAY_MS),
      );
    },
    untyped: () => untyped,
    invalidatePackages() {
      generation++;
      requested.clear();
      untyped.clear();
      clearPending = true;
    },
    invalidateLocal(tabId) {
      bumpLocalGeneration(tabId);
      deps.environment.clearLocal(tabId);
    },
    forget(tabId) {
      if (disposed) return;
      const existing = scheduled.get(tabId);
      if (existing !== undefined) {
        timers.clearTimeout(existing);
        scheduled.delete(tabId);
      }
      bumpLocalGeneration(tabId);
      deps.environment.clearLocal(tabId);
    },
    dispose() {
      disposed = true;
      for (const handle of scheduled.values()) timers.clearTimeout(handle);
      scheduled.clear();
    },
  };
}
