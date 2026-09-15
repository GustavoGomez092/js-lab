import { packageNameFromSpecifier } from "@jslab/npm/specifiers";
import type { LocalTypesResult, PackageTypesResult } from "@jslab/rpc-schema";
import type { TimerApi } from "../state/auto-run";
import type { TsEnvironment } from "./ts-environment";

/** Spec §6.2: the UI requests types for the imports in a model, debounced 500 ms. */
export const TYPE_FEED_DELAY_MS = 500;

const PATTERNS = [
  /\bfrom\s*["']([^"'\n]+)["']/g,
  /\bimport\s*\(\s*["']([^"'\n]+)["']\s*\)/g,
  /\brequire\s*\(\s*["']([^"'\n]+)["']\s*\)/g,
  /^\s*import\s*["']([^"'\n]+)["']/gm,
];

export function importSpecifiers(code: string): { packages: string[]; relative: string[] } {
  const packages = new Set<string>();
  const relative = new Set<string>();
  for (const pattern of PATTERNS) {
    for (const match of code.matchAll(pattern)) {
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
  schedule(tabId: string, code: string, hasWorkingDirectory: boolean): void;
  /** Installed packages without types, with the @types package to offer (or null). */
  untyped(): ReadonlyMap<string, string | null>;
  invalidatePackages(): void;
  invalidateLocal(tabId: string): void;
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
  let generation = 0;

  const requestPackages = async (tabId: string, names: readonly string[]): Promise<void> => {
    const fresh = [...new Set(names)].filter((name) => !requested.has(name)).slice(0, 50);
    if (fresh.length === 0) return;
    for (const name of fresh) requested.add(name);
    const started = generation;
    try {
      const results = await deps.requestPackages(tabId, fresh);
      if (started !== generation) return;
      const dependencies: string[] = [];
      for (const entry of results) {
        if (entry.files.length > 0) deps.environment.setPackageFiles(entry.name, entry.files);
        // Only an installed package without types names an @types package (Task 13). A package that isn't installed
        // (typesPackage null) keeps "Install package x" from its 2307 marker instead of offering @types/x.
        if (!entry.hasTypes && entry.typesPackage !== null) untyped.set(entry.name, entry.typesPackage);
        else untyped.delete(entry.name);
        dependencies.push(...entry.dependencies);
      }
      await requestPackages(tabId, dependencies);
    } catch (error) {
      for (const name of fresh) requested.delete(name);
      deps.log?.("Couldn't load package types", String(error));
    }
  };

  const feed = async (tabId: string, code: string, hasWorkingDirectory: boolean) => {
    const { packages, relative } = importSpecifiers(code);
    if (!hasWorkingDirectory) {
      deps.environment.clearLocal(tabId);
      await requestPackages(tabId, packages);
      return;
    }
    let localPackages: string[] = [];
    if (relative.length > 0) {
      try {
        const local = await deps.requestLocal(tabId, relative.slice(0, 200));
        deps.environment.setLocalFiles(tabId, local.files);
        localPackages = local.packages;
      } catch (error) {
        deps.log?.("Couldn't load working-directory types", String(error));
      }
    }
    await requestPackages(tabId, [...packages, ...localPackages]);
  };

  return {
    schedule(tabId, code, hasWorkingDirectory) {
      const existing = scheduled.get(tabId);
      if (existing !== undefined) timers.clearTimeout(existing);
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
      deps.environment.clearPackages();
    },
    invalidateLocal(tabId) {
      deps.environment.clearLocal(tabId);
    },
    dispose() {
      for (const handle of scheduled.values()) timers.clearTimeout(handle);
      scheduled.clear();
    },
  };
}
