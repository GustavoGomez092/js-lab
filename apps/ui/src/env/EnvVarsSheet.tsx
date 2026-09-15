import { MAX_ENV_VALUE_CHARS, MAX_ENV_VARS } from "@jslab/shared";
import { useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import type { MainApi } from "../api";
import { useSheetFocus } from "../shell/sheet-focus";
import type { AppStore } from "../state/store";
import { strings } from "../strings";
import {
  addEnvRow,
  type EnvRow,
  type EnvTableError,
  removeEnvRow,
  rowsFromPaste,
  rowsFromVariables,
  updateEnvRow,
  validateEnvTable,
} from "./env-table";

const rowKey = (rows: readonly EnvRow[]): string => JSON.stringify(rows.map((row) => [row.key, row.value]));

/** Tools → Environment Variables… (spec §12.1), a modal sheet (spec §7.5). */
export function EnvVarsSheet({ store, api }: { store: AppStore; api: Pick<MainApi, "getEnv" | "saveEnv"> }) {
  const open = useStore(store, (s) => s.modal?.kind === "env");
  // Fix round 1 (N-5): a fresh session per opening, keyed below, so a closed sheet's state (including
  // revealed secret values) never lingers in memory and a stale in-flight load/save can't affect a new one.
  const session = useRef(0);
  const wasOpen = useRef(false);
  if (open && !wasOpen.current) session.current += 1;
  wasOpen.current = open;
  if (!open) return null;
  return <EnvForm key={session.current} store={store} api={api} />;
}

function EnvForm({ store, api }: { store: AppStore; api: Pick<MainApi, "getEnv" | "saveEnv"> }) {
  const [rows, setRows] = useState<EnvRow[]>([]);
  const [draft, setDraft] = useState({ key: "", value: "" });
  const [errors, setErrors] = useState<EnvTableError[]>([]);
  // Fix round 1 (M-2): load/save failures (role="alert") and informational text like a paste result
  // (role="status") are separate slots, so a paste after a failed load can't erase why Save is disabled.
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  // R25-2: a transient read failure must never let an empty sheet overwrite env.json with {}.
  const [loaded, setLoaded] = useState(false);
  // Fix round 1 (M-1): disables Save and shows while a save is in flight; the actual double-submit guard is
  // the synchronous `savingRef` below, since two ⌘↵ presses in the same tick both close over `saving === false`.
  const [saving, setSaving] = useState(false);
  const [newValueRevealed, setNewValueRevealed] = useState(false);
  const newKey = useRef<HTMLInputElement>(null);
  const newValue = useRef<HTMLInputElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  // R25-5/N-2: the loaded row list (key, value pairs; fix round 1 stopped comparing the collapsed variables
  // object, which hid a duplicate-key row from the "Unsaved changes" marker) to detect unsaved edits.
  const initial = useRef<string>("");
  const savingRef = useRef(false);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  // R25-1: this form exists only while the sheet is open, so its own mount/unmount is the open/close
  // transition; the opener snapshot happens before the load effect's `newKey.focus()` below.
  useSheetFocus(true, sheetRef);

  useEffect(() => {
    api.getEnv().then(
      (variables) => {
        if (!mounted.current) return;
        const fromVariables = rowsFromVariables(variables);
        setRows(fromVariables);
        initial.current = rowKey(fromVariables);
        setLoaded(true);
      },
      () => {
        if (mounted.current) setError(strings.env.loadFailed);
      },
    );
    newKey.current?.focus();
  }, [api]);

  // R25-4: after a failed Save, move focus (and VoiceOver) to the first problem instead of red text alone.
  // Fix round 1 (M-5): each input only carries `aria-invalid` for its own error kind, so the first one found
  // in DOM order is the key input when a row has a key error, and the value input when it only has a value
  // error — "the right control" without extra logic.
  useEffect(() => {
    if (errors.length === 0) return;
    sheetRef.current?.querySelector<HTMLInputElement>('input[aria-invalid="true"]')?.focus();
  }, [errors]);

  const close = () => store.getState().closeModal();
  const add = () => {
    if (!draft.key.trim()) return;
    setRows((current) => addEnvRow(current, draft.key, draft.value));
    setDraft({ key: "", value: "" });
    newKey.current?.focus();
  };
  const save = async () => {
    if (!loaded || savingRef.current) return;
    setError(null);
    const all = draft.key.trim() ? addEnvRow(rows, draft.key, draft.value) : rows;
    const result = validateEnvTable(all);
    if (!result.ok) {
      setRows(all);
      setDraft({ key: "", value: "" });
      setErrors(result.errors);
      return;
    }
    setErrors([]);
    // Fix round 1 (M-1): set synchronously, so a second ⌘↵ fired before this render commits still sees it.
    savingRef.current = true;
    setSaving(true);
    try {
      const saved = await api.saveEnv(result.variables);
      // Fix round 1 (M-1/N-5): a save whose sheet closed and reopened while it was in flight must not affect
      // the new session — neither by closing it nor by showing its result.
      if (!mounted.current) return;
      if (saved.ok) {
        if (store.getState().modal?.kind === "env") {
          // R25-5: env changes have no other visible effect, so Save confirms it and says when it applies.
          store.getState().setStatusMessage(strings.env.saved(Object.keys(result.variables).length));
          store.getState().closeModal();
        }
      } else {
        setError(strings.env.saveFailed(saved.error));
      }
    } catch (err) {
      // R-M3-T25-SAVE-1: a rejected save (e.g. InvalidPayloadError) must never become an unhandled rejection
      // or strand the sheet; keep the rows and show the same message a handled failure would.
      if (mounted.current) setError(strings.env.saveFailed(err instanceof Error ? err.message : String(err)));
    } finally {
      savingRef.current = false;
      if (mounted.current) setSaving(false);
    }
  };
  // Fix round 1 (M-3): a ref to the latest `save` closure, so the document-level listener below (added once,
  // for the whole session) always calls Save with the current rows/draft/loaded/saving, not a stale render's.
  const saveRef = useRef(save);
  saveRef.current = save;

  // Fix round 1 (M-3): Escape and ⌘↵ must work even when focus has left the sheet's inputs (for example after
  // a click on the heading or the backdrop blurs the active element to <body>), the same fix ConfirmDialog's
  // m-5 round made. Added and removed with this form's mount/unmount, i.e. with the open session.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (store.getState().modal?.kind !== "env") return;
      if (event.key === "Escape") {
        event.preventDefault();
        store.getState().closeModal();
      } else if (event.key === "Enter" && event.metaKey) {
        event.preventDefault();
        void saveRef.current();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [store]);

  const keyErrorFor = (index: number) =>
    errors.find((entry) => entry.index === index && (entry.error === "invalidKey" || entry.error === "duplicateKey"));
  const valueErrorFor = (index: number) =>
    errors.find((entry) => entry.index === index && entry.error === "valueTooLong");
  const tooManyActive = errors.some((entry) => entry.error === "tooMany");
  // Fix round 1 (M-5): `tooMany` isn't a per-row error, so it renders in the same sheet-level slot a load or
  // save failure uses, computed live from the current validation errors rather than stored separately.
  const alertText = error ?? (tooManyActive ? strings.env.tooMany(MAX_ENV_VARS) : null);
  const dirty = loaded && (rowKey(rows) !== initial.current || draft.key.trim() !== "");
  const secretInputProps = {
    autoComplete: "off",
    autoCorrect: "off",
    autoCapitalize: "off",
    spellCheck: false,
  } as const;

  return (
    <div className="dialog-backdrop">
      <div ref={sheetRef} className="sheet" role="dialog" aria-modal="true" aria-label={strings.env.title}>
        <h2>{strings.env.title}</h2>
        <p className="sheet-help">{strings.env.help}</p>
        <table className="env-table">
          <thead>
            <tr>
              <th>{strings.env.key}</th>
              <th>{strings.env.value}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {loaded && rows.length === 0 && (
              <tr>
                <td colSpan={3} className="sheet-help">
                  {strings.env.empty}
                </td>
              </tr>
            )}
            {rows.map((row, index) => {
              const keyErr = keyErrorFor(index);
              const valueErr = valueErrorFor(index);
              return (
                <tr key={row.id} className={keyErr || valueErr ? "invalid" : undefined}>
                  <td>
                    <input
                      aria-label={strings.env.keyOf(index + 1)}
                      aria-invalid={Boolean(keyErr)}
                      aria-describedby={keyErr ? `env-key-error-${row.id}` : undefined}
                      {...secretInputProps}
                      value={row.key}
                      onChange={(event) =>
                        setRows((current) => updateEnvRow(current, row.id, { key: event.target.value }))
                      }
                    />
                    {keyErr && (
                      <span id={`env-key-error-${row.id}`} className="env-error">
                        {strings.env.errors[keyErr.error as "invalidKey" | "duplicateKey"]}
                      </span>
                    )}
                  </td>
                  <td>
                    <div className="env-value">
                      <input
                        aria-label={strings.env.valueOf(row.key)}
                        aria-invalid={Boolean(valueErr)}
                        aria-describedby={valueErr ? `env-value-error-${row.id}` : undefined}
                        {...secretInputProps}
                        type={row.revealed ? "text" : "password"}
                        value={row.value}
                        onChange={(event) =>
                          setRows((current) => updateEnvRow(current, row.id, { value: event.target.value }))
                        }
                      />
                      <button
                        type="button"
                        aria-label={row.revealed ? strings.env.hide(row.key) : strings.env.reveal(row.key)}
                        aria-pressed={row.revealed}
                        onClick={() => setRows((current) => updateEnvRow(current, row.id, { revealed: !row.revealed }))}
                      >
                        {row.revealed ? strings.env.hideButton : strings.env.showButton}
                      </button>
                    </div>
                    {valueErr && (
                      <span id={`env-value-error-${row.id}`} className="env-error">
                        {strings.env.valueTooLong(row.key, MAX_ENV_VALUE_CHARS)}
                      </span>
                    )}
                  </td>
                  <td>
                    <button
                      type="button"
                      aria-label={strings.env.remove(row.key)}
                      onClick={() => setRows((current) => removeEnvRow(current, row.id))}
                    >
                      ×
                    </button>
                  </td>
                </tr>
              );
            })}
            <tr className="env-new">
              <td>
                <input
                  ref={newKey}
                  aria-label={strings.env.newKey}
                  placeholder={strings.env.key}
                  {...secretInputProps}
                  value={draft.key}
                  onChange={(event) => setDraft({ ...draft, key: event.target.value })}
                  onPaste={(event) => {
                    // R25-3: moving a project's .env into the table takes one paste instead of many fields.
                    const next = rowsFromPaste(rows, event.clipboardData.getData("text"));
                    if (next) {
                      event.preventDefault();
                      setRows(next);
                      setInfo(strings.env.pasted(next.length - rows.length));
                    }
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.metaKey) {
                      event.preventDefault();
                      newValue.current?.focus();
                    }
                  }}
                />
              </td>
              <td className="env-value">
                <input
                  ref={newValue}
                  aria-label={strings.env.newValue}
                  placeholder={strings.env.value}
                  {...secretInputProps}
                  type={newValueRevealed ? "text" : "password"}
                  value={draft.value}
                  onChange={(event) => setDraft({ ...draft, value: event.target.value })}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.metaKey) {
                      event.preventDefault();
                      add();
                    }
                  }}
                />
                <button
                  type="button"
                  aria-label={newValueRevealed ? strings.env.hideNew : strings.env.revealNew}
                  aria-pressed={newValueRevealed}
                  onClick={() => setNewValueRevealed((revealed) => !revealed)}
                >
                  {newValueRevealed ? strings.env.hideButton : strings.env.showButton}
                </button>
              </td>
              <td>
                <button type="button" onClick={add}>
                  {strings.env.add}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
        {alertText && (
          <p className="sheet-status" role="alert">
            {alertText}
          </p>
        )}
        {info && (
          <p className="env-info" role="status">
            {info}
          </p>
        )}
        <div className="dialog-actions">
          {dirty && (
            <span className="sheet-status" role="status">
              {strings.tabs.unsaved}
            </span>
          )}
          <button type="button" onClick={close}>
            {strings.env.cancel}
          </button>
          <button type="button" className="primary" disabled={!loaded || saving} onClick={() => void save()}>
            {strings.env.save}{" "}
            <span className="kbd" aria-hidden="true">
              ⌘↵
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}
