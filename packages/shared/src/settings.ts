import { z } from "zod";

export const LANGUAGES = ["typescript", "javascript", "tsx", "jsx"] as const;
export const RUNTIMES = ["browser-node", "bun", "browser"] as const;
export type Language = (typeof LANGUAGES)[number];
export type Runtime = (typeof RUNTIMES)[number];

/**
 * Defaults for new tabs (spec §8 `run.defaultRuntime` / `run.defaultLanguage`; §7.3 "New uses the default language and
 * runtime"). Both the settings schema and the tab schema read these, so they can't drift apart. M1 runs every tab on
 * Bun regardless: `run.start` carries no runtime and the coordinator only has the Bun adapter (runtime switching is M4).
 */
export const DEFAULT_RUNTIME: Runtime = "browser-node";
export const DEFAULT_LANGUAGE: Language = "typescript";

// Every field repairs itself: a missing or invalid value falls back to its default (spec §8).
const bool = (fallback: boolean) => z.boolean().catch(fallback);
const int = (fallback: number, min: number, max: number) => z.number().int().min(min).max(max).catch(fallback);
const text = (fallback: string) => z.string().min(1).catch(fallback);

function section<T extends z.ZodRawShape>(shape: T) {
  const schema = z.looseObject(shape);
  return schema.catch(() => schema.parse({}));
}

export const settingsSchema = z.looseObject({
  version: z.literal(1).catch(1),
  run: section({
    autoRun: bool(true),
    autoLog: bool(true),
    showUndefined: bool(false),
    loopProtection: bool(true),
    loopProtectionMaxIterations: int(2000, 100, 10_000_000),
    autoRunDelayMs: int(300, 0, 5000),
    unresponsiveTimeoutMs: int(3000, 1000, 60_000),
    defaultLanguage: z.enum(LANGUAGES).catch(DEFAULT_LANGUAGE),
    defaultRuntime: z.enum(RUNTIMES).catch(DEFAULT_RUNTIME),
  }),
  output: section({
    maxEntries: int(10_000, 100, 100_000),
    showLineNumbers: bool(true),
  }),
  editor: section({
    lineNumbers: bool(true),
    lineWrap: bool(true),
  }),
  appearance: section({
    theme: text("dracula"),
    font: text("JetBrains Mono"),
    fontSize: int(14, 8, 72),
  }),
});

export type Settings = z.infer<typeof settingsSchema>;

export function defaultSettings(): Settings {
  return settingsSchema.parse({});
}

export type DeepPartial<T> = T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge(base: unknown, patch: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch === undefined ? base : patch;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) out[key] = deepMerge(base[key], value);
  return out;
}

/** Applies a partial update and re-validates, so invalid patch values fall back to defaults. */
export function mergeSettings(current: Settings, patch: DeepPartial<Settings>): Settings {
  return settingsSchema.parse(deepMerge(current, patch));
}

export interface RunnerSettings {
  autoLog: boolean;
  loopProtection: boolean;
  loopProtectionMaxIterations: number;
  maxEntries: number;
  unresponsiveTimeoutMs: number;
}

export function runnerSettings(settings: Settings): RunnerSettings {
  return {
    autoLog: settings.run.autoLog,
    loopProtection: settings.run.loopProtection,
    loopProtectionMaxIterations: settings.run.loopProtectionMaxIterations,
    maxEntries: settings.output.maxEntries,
    unresponsiveTimeoutMs: settings.run.unresponsiveTimeoutMs,
  };
}
