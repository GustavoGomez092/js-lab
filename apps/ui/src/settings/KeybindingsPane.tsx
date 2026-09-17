import type { CommandCatalogEntry } from "@jslab/rpc-schema";
import type { KeybindingRule } from "@jslab/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { strings } from "../strings";
import { type KeybindingRow, keybindingRows } from "./keybinding-rows";
import type { SettingsApi } from "./settings-rpc";

export interface KeybindingsPaneHandle {
  rows(): KeybindingRow[];
  query(): string;
  setQuery(query: string): void;
  status(): string | null;
}

const text = strings.settings.keybindings;

/** Settings → Keybindings (spec §6.5): the searchable Command / Keybinding / When / Source table. */
export function KeybindingsPane({
  api,
  onReady,
}: {
  api: Pick<SettingsApi, "getKeybindings" | "commandCatalog" | "appCommand" | "on">;
  onReady?(handle: KeybindingsPaneHandle | null): void;
}) {
  // Guards against setting state after the Settings window unmounts while the first load is still in flight.
  const mounted = useRef(true);
  const [catalogue, setCatalogue] = useState<CommandCatalogEntry[] | null>(null);
  const [defaults, setDefaults] = useState<readonly KeybindingRule[]>([]);
  const [rules, setRules] = useState<readonly KeybindingRule[]>([]);
  const [query, setQuery] = useState("");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    void Promise.all([api.commandCatalog(), api.getKeybindings()]).then(
      ([catalog, keybindings]) => {
        if (!mounted.current) return;
        setCatalogue(catalog.commands);
        setDefaults(keybindings.defaults);
        setRules(keybindings.rules);
      },
      () => {
        if (mounted.current) setFailed(true);
      },
    );
  }, [api]);

  // Finding K1: a keybindings.json write reaches this pane without a relaunch, whoever made it -- the user
  // editing the file by hand, or Task 12 saving a capture. Main broadcasts the whole override set, never a delta.
  useEffect(() => api.on("keybindings.changed", ({ rules: next }) => setRules(next)), [api]);

  const rows = useMemo(
    () => (catalogue ? keybindingRows(catalogue, defaults, rules, query) : []),
    [catalogue, defaults, rules, query],
  );
  const titles = useMemo(() => new Map((catalogue ?? []).map((entry) => [entry.id, entry.title])), [catalogue]);

  const latest = useRef({ rows, query, failed });
  latest.current = { rows, query, failed };

  useEffect(() => {
    if (!catalogue) return;
    onReady?.({
      rows: () => latest.current.rows,
      query: () => latest.current.query,
      setQuery,
      status: () => (latest.current.failed ? text.loadFailed : null),
    });
    return () => onReady?.(null);
  });

  return (
    <section className="keybindings">
      <h2>{text.title}</h2>
      <p className="field-help">{text.help}</p>
      <input
        type="search"
        className="settings-search"
        aria-label={text.search}
        placeholder={text.search}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {failed && (
        <p className="keybindings-status" role="alert">
          {text.loadFailed}
        </p>
      )}
      <table className="keybindings-table">
        <thead>
          <tr>
            <th scope="col">{text.columns.command}</th>
            <th scope="col">{text.columns.keybinding}</th>
            <th scope="col">{text.columns.when}</th>
            <th scope="col">{text.columns.source}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.command}>
              <td>
                {row.title}
                {!row.registered && <span className="keybindings-note">{text.unregistered}</span>}
              </td>
              <td>
                {row.keyLabel && <span className="kbd">{row.keyLabel}</span>}
                {row.conflicts.length > 0 && (
                  <span className="keybindings-conflict">
                    {text.conflict(row.conflicts.map((id) => titles.get(id) ?? id).join(", "))}
                  </span>
                )}
              </td>
              <td>{row.when}</td>
              <td>{text.source[row.source]}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {catalogue && rows.length === 0 && <p className="keybindings-empty">{text.empty}</p>}
      <div className="settings-actions">
        <button type="button" onClick={() => api.appCommand("openKeybindingsFile")}>
          {text.openFile}
        </button>
      </div>
    </section>
  );
}
