import { z } from "zod";

export const LANGUAGES = ["typescript", "javascript", "tsx", "jsx"] as const;
export const RUNTIMES = ["browser-node", "bun", "browser"] as const;
export type Language = (typeof LANGUAGES)[number];
export type Runtime = (typeof RUNTIMES)[number];

/**
 * Defaults for new tabs (spec §8 `run.defaultRuntime` / `run.defaultLanguage`; §7.3). As built by the M1 fix wave: the
 * settings schema and the tab schema both read these, so they can't drift apart.
 */
export const DEFAULT_RUNTIME: Runtime = "browser-node";
export const DEFAULT_LANGUAGE: Language = "typescript";

/** Runtimes that can execute code in this build. M4 adds "browser-node" and "browser". */
export const AVAILABLE_RUNTIMES: readonly Runtime[] = ["bun"];

export function isRuntimeAvailable(runtime: Runtime): boolean {
  return AVAILABLE_RUNTIMES.includes(runtime);
}

/** The runtime a new tab actually gets: the requested one when available, otherwise Bun. */
export function effectiveRuntime(runtime: Runtime): Runtime {
  return isRuntimeAvailable(runtime) ? runtime : "bun";
}

export const UI_LANGUAGES = ["system", "en", "es", "ja", "zh", "pt"] as const;
export const SETTINGS_VERSION = 3;
/** `build.decorators` (spec §8 Build): standard 2023-11 decorators, TypeScript's legacy decorators, or no decorators. */
export const DECORATOR_MODES = ["none", "2023-11", "legacy"] as const;
export type DecoratorMode = (typeof DECORATOR_MODES)[number];
export const DEFAULT_DARK_THEME = "graphite";
export const DEFAULT_LIGHT_THEME = "graphite-light";

// Every field repairs itself: a missing or invalid value falls back to its default (spec §8).
const bool = (fallback: boolean) => z.boolean().catch(fallback);
const int = (fallback: number, min: number, max: number) => z.number().int().min(min).max(max).catch(fallback);
const num = (fallback: number, min: number, max: number) => z.number().min(min).max(max).catch(fallback);
const text = (fallback: string) => z.string().min(1).max(200).catch(fallback);
const choice = <const T extends readonly [string, ...string[]]>(values: T, fallback: T[number]) =>
  z.enum(values).catch(fallback);

function section<T extends z.ZodRawShape>(shape: T) {
  const schema = z.looseObject(shape);
  return schema.catch(() => schema.parse({}));
}

export const settingsSchema = z.looseObject({
  version: z.literal(SETTINGS_VERSION).catch(SETTINGS_VERSION),
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
    formatOnRun: bool(false),
  }),
  tabs: section({
    confirmClose: bool(false),
  }),
  app: section({
    uiLanguage: choice(UI_LANGUAGES, "system"),
  }),
  output: section({
    maxEntries: int(10_000, 100, 100_000),
    showLineNumbers: bool(true),
    highlighting: bool(true),
  }),
  editor: section({
    lineNumbers: bool(true),
    lineWrap: bool(true),
    vimKeys: bool(false),
    closeBrackets: bool(true),
    invisibles: bool(false),
    activeLine: bool(false),
    autocomplete: bool(true),
    linting: bool(true),
    hoverInfo: bool(true),
    hoverDelayMs: int(400, 100, 2000),
    signatures: bool(true),
    formatOnSave: bool(false),
    minimap: bool(false),
  }),
  prettier: section({
    printWidth: int(80, 20, 320),
    tabWidth: int(2, 1, 16),
    useTabs: bool(false),
    semi: bool(true),
    singleQuote: bool(false),
    quoteProps: choice(["as-needed", "consistent", "preserve"], "as-needed"),
    jsxSingleQuote: bool(false),
    trailingComma: choice(["all", "es5", "none"], "all"),
    bracketSpacing: bool(true),
    bracketSameLine: bool(false),
    arrowParens: choice(["always", "avoid"], "always"),
  }),
  appearance: section({
    theme: text(DEFAULT_DARK_THEME),
    followSystem: bool(false),
    lightTheme: text(DEFAULT_LIGHT_THEME),
    darkTheme: text(DEFAULT_DARK_THEME),
    font: text("JetBrains Mono"),
    fontSize: int(14, 8, 72),
    fontLigatures: bool(true),
    uiScale: num(1, 0.5, 2),
  }),
  view: section({
    tabBarForSingleTab: bool(true),
    activityBar: bool(true),
    statusBar: bool(true),
    sideBar: bool(false),
    layout: choice(["horizontal", "vertical"], "horizontal"),
  }),
  updates: section({
    auto: bool(true),
    channel: choice(["stable", "canary"], "stable"),
  }),
  npm: section({
    allowInstallScripts: bool(false),
    autoInstallTypes: bool(false),
  }),
  build: section({
    decorators: choice(DECORATOR_MODES, "2023-11"),
    pipelineOperator: bool(false),
    doExpressions: bool(false),
    throwExpressions: bool(false),
    functionSent: bool(false),
    regexpModifiers: bool(true),
    optionalChainingAssign: bool(true),
  }),
});

export type Settings = z.infer<typeof settingsSchema>;

export const SETTINGS_SECTIONS = [
  "run",
  "tabs",
  "app",
  "output",
  "editor",
  "prettier",
  "appearance",
  "view",
  "updates",
  "npm",
  "build",
] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];
export type SettingKey = `${SettingsSection}.${string}`;

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

export function readSetting(settings: Settings, key: SettingKey): unknown {
  const [sectionName, field] = key.split(".") as [SettingsSection, string];
  const values = settings[sectionName] as Record<string, unknown> | undefined;
  return values && Object.hasOwn(values, field) ? values[field] : undefined;
}

export function settingPatch(key: SettingKey, value: unknown): DeepPartial<Settings> {
  const [sectionName, field] = key.split(".") as [SettingsSection, string];
  return { [sectionName]: { [field]: value } } as DeepPartial<Settings>;
}

/** View → Zoom In/Out/Actual Size steps (spec §6.5); `appearance.uiScale` scales editor, output and sidebar. */
export const ZOOM_LEVELS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2] as const;

export function nextZoom(current: number, direction: -1 | 0 | 1): number {
  if (direction === 0) return 1;
  if (direction === 1)
    return ZOOM_LEVELS.find((level) => level > current + 0.001) ?? ZOOM_LEVELS[ZOOM_LEVELS.length - 1] ?? 2;
  return [...ZOOM_LEVELS].reverse().find((level) => level < current - 0.001) ?? ZOOM_LEVELS[0] ?? 0.5;
}

/** The Build tab (spec §8): syntax proposals the transform enables, and the editor's decorator mode. */
export interface BuildSettings {
  decorators: DecoratorMode;
  pipelineOperator: boolean;
  doExpressions: boolean;
  throwExpressions: boolean;
  functionSent: boolean;
  regexpModifiers: boolean;
  optionalChainingAssign: boolean;
}

export function buildSettings(settings: Settings): BuildSettings {
  const build = settings.build;
  return {
    decorators: build.decorators,
    pipelineOperator: build.pipelineOperator,
    doExpressions: build.doExpressions,
    throwExpressions: build.throwExpressions,
    functionSent: build.functionSent,
    regexpModifiers: build.regexpModifiers,
    optionalChainingAssign: build.optionalChainingAssign,
  };
}

export interface RunnerSettings {
  autoLog: boolean;
  loopProtection: boolean;
  loopProtectionMaxIterations: number;
  maxEntries: number;
  unresponsiveTimeoutMs: number;
  build: BuildSettings;
}

export function runnerSettings(settings: Settings): RunnerSettings {
  return {
    autoLog: settings.run.autoLog,
    loopProtection: settings.run.loopProtection,
    loopProtectionMaxIterations: settings.run.loopProtectionMaxIterations,
    maxEntries: settings.output.maxEntries,
    unresponsiveTimeoutMs: settings.run.unresponsiveTimeoutMs,
    build: buildSettings(settings),
  };
}
