import type { SettingsUpdateParams, SystemFontList } from "@jslab/rpc-schema";
import { readSetting, type Settings, settingPatch } from "@jslab/shared";
import { getTheme, listThemes, resolveThemeId } from "@jslab/themes";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { strings } from "../strings";
import { applyThemeVariables } from "../themes/apply";
import { BUNDLED_FONTS } from "../themes/fonts";
import { coerceFieldValue, type FieldDef, fieldsFor, SETTINGS_TABS, type SettingsTab } from "./fields";
import { KeybindingsPane, type KeybindingsPaneHandle } from "./KeybindingsPane";
import { type CreateTextEditor, NpmrcEditor, type NpmrcEditorHandle } from "./NpmrcEditor";
import { createSettingsAgent } from "./settings-agent";
import type { SettingsApi } from "./settings-rpc";

type FontsState = { fonts: SystemFontList | null; refreshing: boolean };

export function SettingsApp({
  api,
  initial,
  e2e = false,
  npmrcEditorFactory,
}: {
  api: SettingsApi;
  initial: Settings;
  e2e?: boolean;
  /** Tests pass a fake editor; the app uses Monaco (loaded lazily). */
  npmrcEditorFactory?: CreateTextEditor;
}) {
  const [settings, setSettings] = useState(initial);
  const [tab, setTab] = useState<SettingsTab>("general");
  const [query, setQuery] = useState("");
  const [fonts, setFonts] = useState<FontsState>({ fonts: null, refreshing: true });
  const [confirmReset, setConfirmReset] = useState(false);
  const npmrc = useRef<NpmrcEditorHandle | null>(null);
  const keys = useRef<KeybindingsPaneHandle | null>(null);
  const snapshot = useRef({ settings, tab, query, fonts });
  snapshot.current = { settings, tab, query, fonts };

  const visible = useMemo(() => fieldsFor(query ? null : tab, query), [tab, query]);

  const set = useCallback(
    async (key: FieldDef["key"], value: boolean | number | string) => {
      try {
        setSettings(await api.update(settingPatch(key, value) as SettingsUpdateParams["patch"]));
      } catch {
        // Main didn't save (a failed write, for example): show what Main holds now, which also resets a number
        // field's draft through its value (review m-3). If that fails too, the next broadcast resyncs the view.
        try {
          setSettings((await api.get()).settings);
        } catch {}
      }
    },
    [api],
  );

  useEffect(() => api.on("settings.changed", ({ settings: next }) => setSettings(next)), [api]);

  useEffect(() => {
    const media = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
    const apply = () =>
      applyThemeVariables(
        getTheme(resolveThemeId(settings.appearance, media?.matches ?? false)),
        document.documentElement,
      );
    apply();
    // FB-m4: while following the system, a macOS appearance change applies here too, as startThemeSync does in the
    // main window.
    if (!media || !settings.appearance.followSystem) return;
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [settings.appearance]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      const result = await api.listFonts();
      if (cancelled) return;
      setFonts(result);
      // Poll only while Main is scanning: a failed scan backs off in Main, so re-asking would only spin (review I-1).
      if (result.refreshing) timer = setTimeout(load, 2000);
    };
    void load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [api]);

  useEffect(() => {
    if (!e2e) return;
    const agent = createSettingsAgent({
      state: () => ({
        ready: true,
        tab: snapshot.current.tab,
        query: snapshot.current.query,
        fieldCount: fieldsFor(snapshot.current.query ? null : snapshot.current.tab, snapshot.current.query).length,
        fontOptions: fontOptionNames(snapshot.current.fonts.fonts),
        settings: snapshot.current.settings,
        npmrc: npmrc.current
          ? { content: npmrc.current.content(), dirty: npmrc.current.dirty(), status: npmrc.current.status() }
          : null,
        keybindings: keys.current
          ? {
              rowCount: keys.current.rows().length,
              query: keys.current.query(),
              status: keys.current.status(),
              capturing: keys.current.capturing(),
            }
          : null,
      }),
      execute: (id, args) => {
        if (id === "settings.set") {
          const { key, value } = args as { key: FieldDef["key"]; value: boolean | number | string };
          void set(key, value);
          return true;
        }
        if (id === "settings.tab") {
          setTab((args as { tab: SettingsTab }).tab);
          return true;
        }
        if (id === "settings.resetAll") {
          api.appCommand("resetSettings");
          return true;
        }
        if (id === "npmrc.set" && npmrc.current) {
          npmrc.current.set(String((args as { content?: unknown }).content ?? ""));
          return true;
        }
        if (id === "npmrc.save" && npmrc.current) {
          void npmrc.current.save();
          return true;
        }
        if (id === "npmrc.reset" && npmrc.current) {
          void npmrc.current.reset();
          return true;
        }
        if (id === "keybindings.search" && keys.current) {
          keys.current.setQuery(String((args as { query?: unknown }).query ?? ""));
          return true;
        }
        if (id === "keybindings.capture" && keys.current) {
          const { command, key } = args as { command?: unknown; key?: unknown };
          return keys.current.capture(String(command ?? ""), String(key ?? ""));
        }
        if (id === "keybindings.resetRow" && keys.current) {
          return keys.current.resetRow(String((args as { command?: unknown }).command ?? ""));
        }
        if (id === "keybindings.resetAll" && keys.current) {
          return keys.current.resetAll();
        }
        return false;
      },
      target: () => document.activeElement ?? document.body,
    });
    return api.on("e2e.request", ({ reqId, method, params }) => {
      agent(method, params).then(
        (result) => api.e2eRespond({ reqId, ok: true, result }),
        (error: unknown) =>
          api.e2eRespond({ reqId, ok: false, error: error instanceof Error ? error.message : String(error) }),
      );
    });
  }, [api, e2e, set]);

  return (
    <div className="settings">
      <div
        className="settings-nav"
        role="tablist"
        aria-orientation="vertical"
        aria-label={strings.settings.windowTitle}
      >
        {SETTINGS_TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={!query && entry.id === tab}
            className={!query && entry.id === tab ? "on" : undefined}
            onClick={() => {
              setQuery("");
              setTab(entry.id);
            }}
          >
            {entry.label}
          </button>
        ))}
      </div>
      <main className="settings-main">
        <input
          type="search"
          className="settings-search"
          aria-label={strings.settings.search}
          placeholder={strings.settings.search}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <h1>{query ? strings.settings.results : strings.settings.tabs[tab]}</h1>
        {!query && tab === "npm" && (
          <NpmrcEditor
            api={api}
            {...(npmrcEditorFactory ? { createEditor: npmrcEditorFactory } : {})}
            onReady={(handle) => {
              npmrc.current = handle;
            }}
          />
        )}
        {!query && tab === "keybindings" && (
          <KeybindingsPane
            api={api}
            onReady={(handle) => {
              keys.current = handle;
            }}
          />
        )}
        <div className="settings-fields">
          {visible.map((field) => (
            <FieldRow
              key={field.key}
              field={field}
              value={readSetting(settings, field.key)}
              fonts={fonts}
              onChange={(value) => void set(field.key, value)}
            />
          ))}
        </div>
        {!query && tab === "advanced" && (
          <div className="settings-actions">
            <button type="button" onClick={() => api.appCommand("openDataFolder")}>
              {strings.settings.openDataFolder}
            </button>
            {confirmReset ? (
              <button
                type="button"
                className="danger"
                onClick={() => {
                  setConfirmReset(false);
                  api.appCommand("resetSettings");
                }}
              >
                {strings.settings.confirmReset}
              </button>
            ) : (
              <button type="button" onClick={() => setConfirmReset(true)}>
                {strings.settings.resetAll}
              </button>
            )}
            <button type="button" onClick={() => api.appCommand("restartSafeMode")}>
              {strings.settings.restartSafeMode}
            </button>
          </div>
        )}
      </main>
    </div>
  );
}

function fontOptionNames(fonts: SystemFontList | null): string[] {
  return [...BUNDLED_FONTS.map((font) => font.name), ...(fonts?.monospace ?? []), ...(fonts?.other ?? [])];
}

function FieldRow(props: {
  field: FieldDef;
  value: unknown;
  fonts: FontsState;
  onChange(value: boolean | number | string): void;
}) {
  const { field, value, fonts, onChange } = props;
  const text = strings.settings.fields[field.key];
  const id = `field-${field.key.replace(".", "-")}`;
  const helpId = `${id}-help`;
  return (
    <div className="field">
      <div className="field-text">
        <label htmlFor={id}>
          {text?.label}
          {field.restart && <span className="field-note">{strings.settings.restartRequired}</span>}
        </label>
        <p id={helpId} className="field-help">
          {text?.help}
        </p>
      </div>
      <div className="field-control">
        <FieldControl id={id} helpId={helpId} field={field} value={value} fonts={fonts} onChange={onChange} />
      </div>
    </div>
  );
}

function FieldControl(props: {
  id: string;
  helpId: string;
  field: FieldDef;
  value: unknown;
  fonts: FontsState;
  onChange(value: boolean | number | string): void;
}) {
  const { id, helpId, field, value, fonts, onChange } = props;
  const kind = field.kind;
  const [draft, setDraft] = useState(String(value ?? ""));
  useEffect(() => setDraft(String(value ?? "")), [value]);

  switch (kind.type) {
    case "bool":
      return (
        <input
          id={id}
          type="checkbox"
          aria-describedby={helpId}
          checked={Boolean(value)}
          onChange={(event) => onChange(event.target.checked)}
        />
      );
    case "int":
    case "number": {
      const commit = () => {
        const next = coerceFieldValue(field, draft);
        if (next === null) setDraft(String(value ?? ""));
        else if (next !== value) onChange(next);
        else setDraft(String(value));
      };
      return (
        <input
          id={id}
          type="number"
          aria-describedby={helpId}
          min={kind.min}
          max={kind.max}
          step={kind.type === "number" ? kind.step : 1}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") commit();
          }}
        />
      );
    }
    case "enum":
      return (
        <select
          id={id}
          aria-describedby={helpId}
          value={String(value)}
          onChange={(event) => onChange(event.target.value)}
        >
          {kind.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      );
    case "theme": {
      const themes = listThemes();
      return (
        <select
          id={id}
          aria-describedby={helpId}
          value={String(value)}
          onChange={(event) => onChange(event.target.value)}
        >
          {(["dark", "light"] as const).map((type) => (
            <optgroup key={type} label={strings.settings.groups[type]}>
              {themes
                .filter((theme) => theme.type === type)
                .map((theme) => (
                  <option key={theme.id} value={theme.id}>
                    {theme.name}
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
      );
    }
    case "font": {
      const system = fonts.fonts;
      const known = new Set(fontOptionNames(system));
      return (
        <select
          id={id}
          aria-describedby={helpId}
          value={String(value)}
          onChange={(event) => onChange(event.target.value)}
        >
          {!known.has(String(value)) && <option value={String(value)}>{String(value)}</option>}
          <optgroup label={strings.settings.groups.bundled}>
            {BUNDLED_FONTS.map((font) => (
              <option key={font.name} value={font.name}>
                {font.name}
              </option>
            ))}
          </optgroup>
          {system ? (
            <>
              <optgroup label={strings.settings.groups.monospace}>
                {system.monospace.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </optgroup>
              <optgroup label={strings.settings.groups.installed}>
                {system.other.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </optgroup>
            </>
          ) : (
            <option disabled>
              {fonts.refreshing ? strings.settings.loadingFonts : strings.settings.fontsUnavailable}
            </option>
          )}
        </select>
      );
    }
  }
}
