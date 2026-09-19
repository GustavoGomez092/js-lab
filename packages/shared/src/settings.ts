import { z } from "zod";

export const LANGUAGES = ["typescript", "javascript", "tsx", "jsx"] as const;
export const RUNTIMES = ["browser-node", "bun", "browser"] as const;
export type Language = (typeof LANGUAGES)[number];
export type Runtime = (typeof RUNTIMES)[number];

/**
 * Defaults for new tabs (spec §8 `run.defaultRuntime` / `run.defaultLanguage`; §7.3). As built by the M1 fix wave: the
 * settings schema and the tab schema both read these, so they can't drift apart.
 */
/**
 * Back to Bun for now (M4 Task 9a). With the browser runtimes really registered, a default tab would route to a
 * web view that loads, receives the code and starts evaluating -- and never reports a result, so the run never
 * finishes. Defaulting to a runtime that cannot complete what it starts is worse than the silent fallback it
 * replaced. This returns to a browser runtime once runs finish there.
 */
export const DEFAULT_RUNTIME: Runtime = "bun";
export const DEFAULT_LANGUAGE: Language = "typescript";

/** Runtimes that can execute code in this build. M4 (Task 9) turns on "browser-node" and "browser" alongside "bun". */
export const AVAILABLE_RUNTIMES: readonly Runtime[] = ["bun", "browser-node", "browser"];

export function isRuntimeAvailable(runtime: Runtime): boolean {
  return AVAILABLE_RUNTIMES.includes(runtime);
}

/** The runtime a new tab actually gets: the requested one when available, otherwise Bun. */
export function effectiveRuntime(runtime: Runtime): Runtime {
  return isRuntimeAvailable(runtime) ? runtime : "bun";
}

export const UI_LANGUAGES = ["system", "en", "es", "ja", "zh", "pt"] as const;
export const SETTINGS_VERSION = 4;

/**
 * Every AI provider the design names (spec §14.3), in the spec's own table order.
 *
 * This is the SEAM, not a claim about what works: it is what `ai.<provider>` Keychain accounts, `models.json`
 * and Main's adapter registry are all keyed by, so adding a provider is adding an adapter and its two settings
 * keys rather than touching any of those three lookups.
 */
export const AI_PROVIDERS = ["openai", "anthropic", "gemini", "mistral", "ollama", "custom"] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

/**
 * The providers this build actually implements, exactly as `AVAILABLE_RUNTIMES` does for runtimes -- and for the
 * same reason that constant exists: offering a choice the app cannot carry out is worse than not offering it.
 * Ollama is first because it needs no credentials, so it is the one provider testable end to end today.
 *
 * `ai.provider` below still ACCEPTS every id in `AI_PROVIDERS`, so a value written by a later build survives a
 * downgrade and a re-upgrade instead of being repaired away; only what the picker offers is narrowed.
 */
export const AVAILABLE_AI_PROVIDERS: readonly AiProvider[] = ["ollama"];

export function isAiProviderAvailable(provider: string): provider is AiProvider {
  return (AVAILABLE_AI_PROVIDERS as readonly string[]).includes(provider);
}

/** `ai.provider`'s "not configured yet" value (spec §8 writes it as `null`; see `AI_PROVIDER_CHOICES`). */
export const AI_PROVIDER_NONE = "none";

/**
 * What `ai.provider` may hold.
 *
 * Spec §8 types this key `enum | null` with a `null` default. `null` is not representable on this wire:
 * `settingsUpdateParamsSchema` (packages/rpc-schema) accepts only `boolean | number | string` as a setting value,
 * so a patch setting the provider back to `null` would be rejected by Main and the user could never UNconfigure
 * a provider. The sentinel `"none"` carries the same meaning through a channel that exists, and keeps the key a
 * plain enum for the settings field table.
 */
export const AI_PROVIDER_CHOICES = [AI_PROVIDER_NONE, ...AI_PROVIDERS] as const;
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
/**
 * A free-text field whose EMPTY value is meaningful, so it cannot use `text()` above (which requires min(1) and
 * would repair `""` back to its fallback). Spec §8 gives `ai.baseUrl.<provider>` the default `""` and defines it
 * as "Blank = the provider's standard endpoint"; `ai.model.<provider>` uses the same convention for "the default
 * model from the manifest", which is what keeps `models.json` the single owner of that default (spec §14.3)
 * rather than freezing a model name into every user's settings.json the first time it is written.
 */
const blankable = (max: number) => z.string().max(max).catch("");
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
  /**
   * Spec §8 (AI) and §14. Only the keys this build can honour are present: the Ollama slice of the
   * `ai.model.<provider>` / `ai.baseUrl.<provider>` families. A second provider adds its own two keys here and a
   * field apiece in `apps/ui/src/settings/fields.ts` -- nothing else in the settings machinery has to move.
   *
   * The API key is deliberately absent: spec §14.3 keeps keys in the Keychain (account `ai.<provider>`), never in
   * settings.json, which is read and written in the clear and copied verbatim into the debug report.
   */
  ai: section({
    provider: choice(AI_PROVIDER_CHOICES, AI_PROVIDER_NONE),
    // Dotted field names, so the key really is `ai.model.ollama` as spec §8 writes it. `readSetting` and
    // `settingPatch` split a key at its FIRST dot for exactly this reason.
    "model.ollama": blankable(200),
    "baseUrl.ollama": blankable(2048),
    includeOutput: bool(true),
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
  "ai",
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

/**
 * A setting key split at its FIRST dot: the section, and the field name within it -- which may itself contain
 * dots (`ai.model.ollama` is the field `model.ollama` of section `ai`, spec §8).
 *
 * `key.split(".")` destructured as `[section, field]` was silently wrong for such a key: it yielded the field
 * `model`, which no section holds, so `readSetting` returned `undefined` and `settingPatch` built a patch that
 * wrote the WRONG key and dropped the provider entirely. Every existing key has exactly one dot, so this is
 * identical to the old behaviour for all of them.
 */
function splitSettingKey(key: SettingKey): [SettingsSection, string] {
  const dot = key.indexOf(".");
  return [key.slice(0, dot) as SettingsSection, key.slice(dot + 1)];
}

export function readSetting(settings: Settings, key: SettingKey): unknown {
  const [sectionName, field] = splitSettingKey(key);
  const values = settings[sectionName] as Record<string, unknown> | undefined;
  return values && Object.hasOwn(values, field) ? values[field] : undefined;
}

export function settingPatch(key: SettingKey, value: unknown): DeepPartial<Settings> {
  const [sectionName, field] = splitSettingKey(key);
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
