import type { CommandCatalogEntry } from "@jslab/rpc-schema";
import type { KeybindingRule } from "@jslab/shared";
import { type KeyboardEvent as ReactKeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
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

/**
 * `from` with every rule addressing `command` dropped -- both the binding and its `-command` removal.
 *
 * R-M5d-T13-RACE-1: deliberately module-scoped and fed the set to derive from, so it CANNOT read the `rules` render
 * state. That read was the bug: a second write dispatched inside the first save's await window computed from the
 * pre-first-save set and silently dropped the first change.
 */
function rulesWithout(from: readonly KeybindingRule[], command: string): KeybindingRule[] {
  return from.filter((rule) => ruleCommand(rule) !== command);
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

  /**
   * The rule set Main last confirmed, advanced SYNCHRONOUSLY. `rules` above is the rendering copy of the same value;
   * this ref is the one every write is derived from, because render state does not refresh until the save that
   * produced it has already resolved (R-M5d-T13-RACE-1).
   */
  const committed = useRef<readonly KeybindingRule[]>([]);
  /**
   * Bumped every time Main tells us what the file holds -- the initial load, or a `keybindings.changed` broadcast.
   * A save that resolves afterwards compares stamps and can tell its own request has been overtaken.
   */
  const fromMain = useRef(0);
  /** Saves run one at a time; see `save` for why the derivation happens at the front of this queue. */
  const queue = useRef<Promise<void>>(Promise.resolve());

  /**
   * Adopt Main's word on the file: it outranks any save request still in flight.
   *
   * Stable across renders -- it touches only refs and a state setter -- so the effects below can depend on it
   * without re-subscribing to `keybindings.changed` on every render.
   */
  const adoptFromMain = useCallback((next: readonly KeybindingRule[]) => {
    fromMain.current += 1;
    committed.current = next;
    setRules(next);
  }, []);

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
        adoptFromMain(keybindings.rules);
        setInvalid(keybindings.invalid);
      },
      () => {
        if (mounted.current) setFailed(true);
      },
    );
  }, [api, adoptFromMain]);

  // Finding K1: a keybindings.json write reaches this pane without a relaunch, whoever made it -- the user
  // editing the file by hand, or a capture saved below. Main broadcasts the whole override set, never a delta.
  useEffect(() => api.on("keybindings.changed", ({ rules: next }) => adoptFromMain(next)), [api, adoptFromMain]);

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

  /**
   * Queues a write, deriving the rule set from `committed` at the moment the write REACHES THE FRONT of the queue --
   * never at dispatch time, and never from render state.
   *
   * R-M5d-T13-RACE-1. Serializing the derivation was chosen over an optimistic ref advanced at dispatch time because
   * with one save in flight at a time there is never an unpersisted value to roll back: a refused save simply does
   * not advance `committed`, so a later write cannot build on a rule Main never wrote. The optimistic variant needs
   * a rollback that is ill-defined the moment a second write has already derived from the value being rolled back.
   * A functional `setRules(prev => ...)` would not help either -- the stale read happens while COMPUTING `next`,
   * before any state update is queued.
   */
  const save = (derive: (from: readonly KeybindingRule[]) => KeybindingRule[]) => {
    setNotice(null);
    const run = async () => {
      if (!mounted.current) return;
      const next = derive(committed.current);
      const stamp = fromMain.current;
      try {
        const result = await api.saveKeybindings(next);
        if (!mounted.current) return;
        if (!result.ok) {
          setNotice(text.saveFailed);
          return;
        }
        // A `keybindings.changed` that landed while this was in flight is Main's newer word on the file, so it wins
        // and this request is dropped rather than rolling the pane back to a set the file no longer holds.
        if (fromMain.current !== stamp) return;
        committed.current = next;
        setRules(next);
      } catch {
        // The raw cause can carry an absolute path (EACCES), so it is never rendered (spec §18).
        if (mounted.current) setNotice(text.saveFailed);
      }
    };
    // Both arms, so one rejected link can never wedge the queue and silently swallow every later save.
    queue.current = queue.current.then(run, run);
  };

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
    save((from) => [
      ...rulesWithout(from, row.command),
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
        save((from) => rulesWithout(from, command));
        return true;
      },
      resetAll: () => {
        if (!writable) return false;
        setConfirmAll(false);
        // Immune to the race by construction: it never reads the current rules at all.
        save(() => []);
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
                      onClick={() => save((from) => rulesWithout(from, row.command))}
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
              save(() => []);
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
