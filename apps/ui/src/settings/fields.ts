import { DECORATOR_MODES, LANGUAGES, RUNTIMES, type SettingKey, UI_LANGUAGES } from "@jslab/shared";
import { strings } from "../strings";

export type SettingsTab = "general" | "editor" | "formatting" | "appearance" | "npm" | "build" | "advanced";

export const SETTINGS_TABS: { id: SettingsTab; label: string }[] = (
  ["general", "editor", "formatting", "appearance", "npm", "build", "advanced"] as const
).map((id) => ({ id, label: strings.settings.tabs[id] }));

export type FieldKind =
  | { type: "bool" }
  | { type: "int"; min: number; max: number }
  | { type: "number"; min: number; max: number; step: number }
  | { type: "enum"; options: { value: string; label: string }[] }
  | { type: "theme" }
  | { type: "font" };

export interface FieldDef {
  key: SettingKey;
  tab: SettingsTab;
  kind: FieldKind;
  restart?: boolean;
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
  }
}
