import type { CommandCatalogEntry } from "@jslab/rpc-schema";
import type { KeybindingRule } from "@jslab/shared";
import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { strings } from "../strings";
import { captureKey, captureSpec } from "./key-capture";
import { type KeybindingRow, keybindingRows } from "./keybinding-rows";
import type { SettingsApi } from "./settings-rpc";

export interface KeybindingsPaneHandle {
  rows(): KeybindingRow[];
  query(): string;
  setQuery(query: string): void;
  status(): string | null;
  /** The command whose capture field is armed, or null. */
  capturing(): string | null;
  capture(command: string, key: string): boolean;
  resetRow(command: string): boolean;
  resetAll(): boolean;
}

const text = strings.settings.keybindings;

/** The command a rule addresses, with the `-` that marks a removal rule stripped off. */
function ruleCommand(rule: KeybindingRule): string {
  return rule.command.startsWith("-") ? rule.command.slice(1) : rule.command;
}

/** Settings → Keybindings (spec §6.5): the searchable Command / Keybinding / When / Source table. */
export function KeybindingsPane({
  api,
  onReady,
}: {
  api: Pick<SettingsApi, "getKeybindings" | "saveKeybindings" | "commandCatalog" | "appCommand" | "on">;
  onReady?(handle: KeybindingsPaneHandle | null): void;
}) {
  // Guards against setting state after the Settings window unmounts while the first load is still in flight.
  const mounted = useRef(true);
  const section = useRef<HTMLElement>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const [catalogue, setCatalogue] = useState<CommandCatalogEntry[] | null>(null);
  const [defaults, setDefaults] = useState<readonly KeybindingRule[]>([]);
  const [rules, setRules] = useState<readonly KeybindingRule[]>([]);
  const [query, setQuery] = useState("");
  const [failed, setFailed] = useState(false);
  // Main could not parse keybindings.json, so every write path here is closed: see `writable` below.
  const [invalid, setInvalid] = useState(false);
  const [capturing, setCapturing] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // R27-1's idiom, as NpmrcEditor uses it: the first Reset All click only asks, the second commits.
  const [confirmAll, setConfirmAll] = useState(false);

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
        setInvalid(keybindings.invalid);
      },
      () => {
        if (mounted.current) setFailed(true);
      },
    );
  }, [api]);

  // Finding K1: a keybindings.json write reaches this pane without a relaunch, whoever made it -- the user
  // editing the file by hand, or a capture saved below. Main broadcasts the whole override set, never a delta.
  useEffect(() => api.on("keybindings.changed", ({ rules: next }) => setRules(next)), [api]);

  const allRows = useMemo(
    () => (catalogue ? keybindingRows(catalogue, defaults, rules, "") : []),
    [catalogue, defaults, rules],
  );
  // Only re-derive when there is something to filter by; with no query the two are the same list.
  const rows = useMemo(
    () => (catalogue && query.trim() ? keybindingRows(catalogue, defaults, rules, query) : allRows),
    [catalogue, defaults, rules, query, allRows],
  );
  const titles = useMemo(() => new Map((catalogue ?? []).map((entry) => [entry.id, entry.title])), [catalogue]);

  /**
   * Whether this pane may write keybindings.json at all.
   *
   * `invalid` means Main could not parse the file, so the store holds no rules. Saving anything now would replace
   * the user's broken file with a set derived from nothing -- at the exact moment they opened it to repair it.
   * Main's `keybindings.save` refuses too; this closes the affordances so the refusal is never reached by accident.
   */
  const writable = !failed && !invalid;

  let status: string | null = notice;
  if (invalid) status = text.fileInvalid;
  if (failed) status = text.loadFailed;

  const save = async (next: KeybindingRule[]) => {
    setNotice(null);
    try {
      const result = await api.saveKeybindings(next);
      if (!mounted.current) return;
      if (result.ok) setRules(next);
      else setNotice(text.saveFailed);
    } catch {
      // The raw cause can carry an absolute path (EACCES), so it is never rendered (spec §18).
      if (mounted.current) setNotice(text.saveFailed);
    }
  };

  const rulesWithout = (command: string) => rules.filter((rule) => ruleCommand(rule) !== command);

  /**
   * Binds `key` to the row's command, retiring every default chord that command still answers to.
   *
   * R-M5d-ALIAS-1: a plain user rule does not delete a default -- both chords go on firing -- so without the
   * removals a "Change" would leave the old keycap sitting beside the new one, both live. The removals are written
   * before the new rule because `resolveKeybindings` applies overrides in file order, and a removal placed after
   * the binding would delete the binding itself whenever the user rebound a command to its own default chord.
   */
  const bind = (row: KeybindingRow, key: string) => {
    const removals = defaults
      .filter((rule) => rule.command === row.command)
      .map((rule) => ({ key: rule.key, command: `-${row.command}` }));
    void save([
      ...rulesWithout(row.command),
      ...removals,
      { key, command: row.command, ...(row.when ? { when: row.when } : {}) },
    ]);
  };

  const onCaptureKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>, row: KeybindingRow) => {
    const outcome = captureKey(event.nativeEvent);
    // `ignored` deliberately does NOT preventDefault: bare Tab has to keep moving focus out of an armed field,
    // or a keyboard-only user is trapped in it.
    if (outcome.kind === "ignored") return;
    event.preventDefault();
    if (outcome.kind === "cancelled") {
      setCapturing(null);
      return;
    }
    if (outcome.kind === "rejected") {
      // The field stays armed and says why, rather than swallowing the key in silence.
      setNotice(text.rejected[outcome.reason]);
      return;
    }
    setCapturing(null);
    bind(row, outcome.key);
  };

  // F1's idiom: "Confirm Reset" disarms as soon as the user moves on without confirming. Document-level, because
  // in WKWebView clicking a button doesn't focus it, so a plain onBlur on the button would never fire.
  useEffect(() => {
    if (!confirmAll) return;
    const doc = section.current?.ownerDocument ?? document;
    const win = doc.defaultView;
    const disarm = (event: Event) => {
      const button = confirmButton.current;
      if (button && event.target instanceof Node && button.contains(event.target)) return;
      setConfirmAll(false);
    };
    const onWindowBlur = () => setConfirmAll(false);
    doc.addEventListener("pointerdown", disarm);
    doc.addEventListener("focusin", disarm);
    win?.addEventListener("blur", onWindowBlur);
    return () => {
      doc.removeEventListener("pointerdown", disarm);
      doc.removeEventListener("focusin", disarm);
      win?.removeEventListener("blur", onWindowBlur);
    };
  }, [confirmAll]);

  const latest = useRef({ rows, query, status, capturing });
  latest.current = { rows, query, status, capturing };

  useEffect(() => {
    if (!catalogue) return;
    onReady?.({
      rows: () => latest.current.rows,
      query: () => latest.current.query,
      setQuery,
      status: () => latest.current.status,
      capturing: () => latest.current.capturing,
      // The E2E path names a chord as text, and goes through the same rules a keystroke does -- a scenario must
      // not be able to bind something the capture field would refuse.
      capture: (command, key) => {
        const row = allRows.find((candidate) => candidate.command === command);
        if (!writable || !row) return false;
        const outcome = captureSpec(key);
        if (outcome.kind === "rejected") {
          setNotice(text.rejected[outcome.reason]);
          return false;
        }
        if (outcome.kind !== "captured") return false;
        setCapturing(null);
        bind(row, outcome.key);
        return true;
      },
      resetRow: (command) => {
        if (!writable || !allRows.some((row) => row.command === command)) return false;
        void save(rulesWithout(command));
        return true;
      },
      resetAll: () => {
        if (!writable) return false;
        setConfirmAll(false);
        void save([]);
        return true;
      },
    });
    return () => onReady?.(null);
  });

  return (
    <section className="keybindings" ref={section}>
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
      {status && (
        <p className="keybindings-status" role="alert">
          {status}
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
                <span className="keybindings-keys">
                  {/* R-M5d-ALIAS-1: every chord bound to this command, not just the highest-precedence one. */}
                  {row.chords.map((chord) => (
                    <span className="kbd" key={chord.key}>
                      {chord.label}
                    </span>
                  ))}
                  {capturing === row.command ? (
                    <input
                      ref={(node) => {
                        node?.focus();
                      }}
                      type="text"
                      readOnly
                      value=""
                      className="keybindings-capture"
                      aria-label={text.capturing(row.title)}
                      onKeyDown={(event) => onCaptureKeyDown(event, row)}
                      onBlur={() => setCapturing(null)}
                    />
                  ) : (
                    <button
                      type="button"
                      className="keybindings-action"
                      aria-label={text.capture(row.title)}
                      disabled={!writable}
                      onClick={() => {
                        setNotice(null);
                        setCapturing(row.command);
                      }}
                    >
                      {text.change}
                    </button>
                  )}
                  {row.customized && (
                    <button
                      type="button"
                      className="keybindings-action"
                      aria-label={text.resetRow(row.title)}
                      disabled={!writable}
                      onClick={() => void save(rulesWithout(row.command))}
                    >
                      {text.reset}
                    </button>
                  )}
                </span>
                {capturing === row.command && <span className="keybindings-hint">{text.captureHint}</span>}
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
        {confirmAll ? (
          <button
            ref={confirmButton}
            type="button"
            className="danger"
            disabled={!writable}
            onClick={() => {
              setConfirmAll(false);
              void save([]);
            }}
          >
            {strings.settings.confirmReset}
          </button>
        ) : (
          <button type="button" disabled={!writable} onClick={() => setConfirmAll(true)}>
            {text.resetAll}
          </button>
        )}
      </div>
    </section>
  );
}
