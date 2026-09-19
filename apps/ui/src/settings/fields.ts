import {
  AI_PROVIDER_NONE,
  type AiProvider,
  AVAILABLE_AI_PROVIDERS,
  DECORATOR_MODES,
  LANGUAGES,
  RUNTIMES,
  type SettingKey,
  UI_LANGUAGES,
} from "@jslab/shared";
import { strings } from "../strings";

export type SettingsTab =
  | "general"
  | "editor"
  | "formatting"
  | "appearance"
  | "keybindings"
  | "ai"
  | "npm"
  | "build"
  | "advanced";

// Spec §8's own order: "General · Editor · Formatting · Appearance · Keybindings · AI · NPM · Build · Advanced".
export const SETTINGS_TABS: { id: SettingsTab; label: string }[] = (
  ["general", "editor", "formatting", "appearance", "keybindings", "ai", "npm", "build", "advanced"] as const
).map((id) => ({ id, label: strings.settings.tabs[id] }));

export type FieldKind =
  | { type: "bool" }
  | { type: "int"; min: number; max: number }
  | { type: "number"; min: number; max: number; step: number }
  | { type: "enum"; options: { value: string; label: string }[] }
  | { type: "theme" }
  | { type: "font" }
  /**
   * Free text whose EMPTY value is meaningful -- `ai.baseUrl.<provider>` blank means "the provider's standard
   * endpoint" and `ai.model.<provider>` blank means "the manifest's default" (spec §8, §14.3).
   *
   * Deliberately not reusing `theme`/`font`, whose coercion rejects blank: with those, clearing the field would
   * silently keep the old value and the user could never get back to the default they started from.
   */
  | { type: "text" };

export interface FieldDef {
  key: SettingKey;
  tab: SettingsTab;
  kind: FieldKind;
  restart?: boolean;
  /**
   * TL-23: this field also offers the models this provider reports, with a Refresh control.
   *
   * Deliberately a property of the FIELD and not a `FieldKind`. The options are dynamic, so they cannot be baked
   * into the kind the way `enum`'s are -- but more importantly the kind must stay `text`, whose coercion keeps
   * blank as a VALUE. Turning this into an `enum` (or reusing `theme`/`font`, which reject blank) would take away
   * the only way back to the manifest's default, which is where every user starts. The picker therefore layers
   * OVER the text input rather than replacing it, and the text input stays editable at all times.
   */
  models?: AiProvider;
}

const bool: FieldKind = { type: "bool" };
const int = (min: number, max: number): FieldKind => ({ type: "int", min, max });
const choices = (labels: Record<string, string>, values: readonly string[] = Object.keys(labels)): FieldKind => ({
  type: "enum",
  options: values.map((value) => ({ value, label: labels[value] ?? value })),
});
const o = strings.settings.options;

export const SETTINGS_FIELDS: FieldDef[] = [
  { key: "run.autoRun", tab: "general", kind: bool },
  { key: "run.autoLog", tab: "general", kind: bool },
  { key: "run.defaultRuntime", tab: "general", kind: choices(o.runtime, RUNTIMES) },
  { key: "run.defaultLanguage", tab: "general", kind: choices(o.language, LANGUAGES) },
  { key: "run.formatOnRun", tab: "general", kind: bool },
  { key: "tabs.confirmClose", tab: "general", kind: bool },
  { key: "app.uiLanguage", tab: "general", kind: choices(o.uiLanguage, UI_LANGUAGES), restart: true },

  { key: "editor.lineNumbers", tab: "editor", kind: bool },
  { key: "editor.lineWrap", tab: "editor", kind: bool },
  { key: "editor.vimKeys", tab: "editor", kind: bool },
  { key: "editor.closeBrackets", tab: "editor", kind: bool },
  { key: "editor.invisibles", tab: "editor", kind: bool },
  { key: "editor.activeLine", tab: "editor", kind: bool },
  { key: "editor.autocomplete", tab: "editor", kind: bool },
  { key: "editor.linting", tab: "editor", kind: bool },
  { key: "editor.hoverInfo", tab: "editor", kind: bool },
  { key: "editor.hoverDelayMs", tab: "editor", kind: int(100, 2000) },
  { key: "editor.signatures", tab: "editor", kind: bool },
  { key: "editor.formatOnSave", tab: "editor", kind: bool },
  { key: "editor.minimap", tab: "editor", kind: bool },

  { key: "prettier.printWidth", tab: "formatting", kind: int(20, 320) },
  { key: "prettier.tabWidth", tab: "formatting", kind: int(1, 16) },
  { key: "prettier.useTabs", tab: "formatting", kind: bool },
  { key: "prettier.semi", tab: "formatting", kind: bool },
  { key: "prettier.singleQuote", tab: "formatting", kind: bool },
  { key: "prettier.quoteProps", tab: "formatting", kind: choices(o.quoteProps) },
  { key: "prettier.jsxSingleQuote", tab: "formatting", kind: bool },
  { key: "prettier.trailingComma", tab: "formatting", kind: choices(o.trailingComma) },
  { key: "prettier.bracketSpacing", tab: "formatting", kind: bool },
  { key: "prettier.bracketSameLine", tab: "formatting", kind: bool },
  { key: "prettier.arrowParens", tab: "formatting", kind: choices(o.arrowParens) },

  { key: "appearance.theme", tab: "appearance", kind: { type: "theme" } },
  { key: "appearance.followSystem", tab: "appearance", kind: bool },
  { key: "appearance.lightTheme", tab: "appearance", kind: { type: "theme" } },
  { key: "appearance.darkTheme", tab: "appearance", kind: { type: "theme" } },
  { key: "appearance.font", tab: "appearance", kind: { type: "font" } },
  { key: "appearance.fontSize", tab: "appearance", kind: int(8, 72) },
  { key: "appearance.fontLigatures", tab: "appearance", kind: bool },
  { key: "appearance.uiScale", tab: "appearance", kind: { type: "number", min: 0.5, max: 2, step: 0.05 } },
  { key: "view.tabBarForSingleTab", tab: "appearance", kind: bool },
  { key: "view.activityBar", tab: "appearance", kind: bool },
  { key: "view.statusBar", tab: "appearance", kind: bool },
  { key: "view.sideBar", tab: "appearance", kind: bool },
  { key: "view.layout", tab: "appearance", kind: choices(o.layout) },
  { key: "output.highlighting", tab: "appearance", kind: bool },
  { key: "output.showLineNumbers", tab: "appearance", kind: bool },

  /**
   * Spec §8 (AI). The picker offers only what this build implements, plus "none" -- `AVAILABLE_AI_PROVIDERS` is
   * the same mechanism `AVAILABLE_RUNTIMES` uses, so a provider becomes selectable by shipping its adapter
   * rather than by editing this list. `ai.provider` itself still accepts all six ids on disk.
   */
  {
    key: "ai.provider",
    tab: "ai",
    kind: choices(o.aiProvider, [AI_PROVIDER_NONE, ...AVAILABLE_AI_PROVIDERS]),
  },
  // TL-23: still `text` -- see `FieldDef.models` for why the picker layers over it instead of replacing it.
  { key: "ai.model.ollama", tab: "ai", kind: { type: "text" }, models: "ollama" },
  { key: "ai.baseUrl.ollama", tab: "ai", kind: { type: "text" } },
  { key: "ai.includeOutput", tab: "ai", kind: bool },

  { key: "npm.allowInstallScripts", tab: "npm", kind: bool },
  { key: "npm.autoInstallTypes", tab: "npm", kind: bool },

  { key: "build.decorators", tab: "build", kind: choices(o.decorators, DECORATOR_MODES) },
  { key: "build.pipelineOperator", tab: "build", kind: bool },
  { key: "build.doExpressions", tab: "build", kind: bool },
  { key: "build.throwExpressions", tab: "build", kind: bool },
  { key: "build.functionSent", tab: "build", kind: bool },
  { key: "build.regexpModifiers", tab: "build", kind: bool },
  { key: "build.optionalChainingAssign", tab: "build", kind: bool },

  { key: "run.showUndefined", tab: "advanced", kind: bool },
  { key: "run.loopProtection", tab: "advanced", kind: bool },
  { key: "run.loopProtectionMaxIterations", tab: "advanced", kind: int(100, 10_000_000) },
  { key: "run.autoRunDelayMs", tab: "advanced", kind: int(0, 5000) },
  { key: "run.unresponsiveTimeoutMs", tab: "advanced", kind: int(1000, 60_000) },
  { key: "output.maxEntries", tab: "advanced", kind: int(100, 100_000) },
  { key: "updates.auto", tab: "advanced", kind: bool },
  { key: "updates.channel", tab: "advanced", kind: choices(o.channel) },
];

export function fieldsFor(tab: SettingsTab | null, query: string): FieldDef[] {
  const q = query.trim().toLowerCase();
  if (!q) return SETTINGS_FIELDS.filter((field) => tab === null || field.tab === tab);
  return SETTINGS_FIELDS.filter((field) => {
    const text = strings.settings.fields[field.key];
    return [text?.label, text?.help, field.key].some((value) => value?.toLowerCase().includes(q));
  });
}

export function coerceFieldValue(field: FieldDef, raw: string | boolean): boolean | number | string | null {
  const kind = field.kind;
  switch (kind.type) {
    case "bool":
      return typeof raw === "boolean" ? raw : raw === "true";
    case "int":
    case "number": {
      if (typeof raw === "boolean" || raw.trim() === "") return null;
      const value = Number(raw);
      if (!Number.isFinite(value)) return null;
      const clamped = Math.min(kind.max, Math.max(kind.min, value));
      return kind.type === "int"
        ? Math.min(kind.max, Math.max(kind.min, Math.round(value)))
        : Math.round(clamped * 100) / 100;
    }
    case "enum":
      return typeof raw === "string" && kind.options.some((option) => option.value === raw) ? raw : null;
    case "theme":
    case "font":
      return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
    // Blank is a VALUE here, not a rejection: it is how the user asks for the default back (see `FieldKind`).
    case "text":
      return typeof raw === "string" ? raw.trim() : null;
  }
}
