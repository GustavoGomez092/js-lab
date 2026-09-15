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
  type EnvRowError,
  removeEnvRow,
  rowsFromPaste,
  rowsFromVariables,
  updateEnvRow,
  validateEnvRows,
} from "./env-table";

const rowsToVariables = (rows: readonly EnvRow[]): Record<string, string> =>
  Object.fromEntries(rows.map((row) => [row.key, row.value]));

/** Tools → Environment Variables… (spec §12.1), a modal sheet (spec §7.5). */
export function EnvVarsSheet({ store, api }: { store: AppStore; api: Pick<MainApi, "getEnv" | "saveEnv"> }) {
  const open = useStore(store, (s) => s.modal?.kind === "env");
  const [rows, setRows] = useState<EnvRow[]>([]);
  const [draft, setDraft] = useState({ key: "", value: "" });
  const [errors, setErrors] = useState<EnvRowError[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  // R25-2: a transient read failure must never let an empty sheet overwrite env.json with {}.
  const [loaded, setLoaded] = useState(false);
  const newKey = useRef<HTMLInputElement>(null);
  const newValue = useRef<HTMLInputElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  // R25-5: what Save would write, at load time, to detect unsaved edits.
  const initial = useRef<string>("");

  // R25-1: declared before the load effect below, so the opener snapshot happens before New key steals focus.
  useSheetFocus(open, sheetRef);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setDraft({ key: "", value: "" });
    setErrors([]);
    setStatus(null);
    setRows([]);
    setLoaded(false);
    initial.current = "";
    api.getEnv().then(
      (variables) => {
        if (cancelled) return;
        setRows(rowsFromVariables(variables));
        initial.current = JSON.stringify(variables);
        setLoaded(true);
      },
      () => {
        if (!cancelled) setStatus(strings.env.loadFailed);
      },
    );
    newKey.current?.focus();
    return () => {
      cancelled = true;
    };
  }, [open, api]);

  // R25-4: after a failed Save, move focus (and VoiceOver) to the first problem instead of red text alone.
  useEffect(() => {
    if (errors.length === 0) return;
    sheetRef.current?.querySelector<HTMLInputElement>("tr.invalid input")?.focus();
  }, [errors]);

  if (!open) return null;

  const close = () => store.getState().closeModal();
  const add = () => {
    if (!draft.key.trim()) return;
    setRows((current) => addEnvRow(current, draft.key, draft.value));
    setDraft({ key: "", value: "" });
    newKey.current?.focus();
  };
  const save = async () => {
    if (!loaded) return;
    const all = draft.key.trim() ? addEnvRow(rows, draft.key, draft.value) : rows;
    const result = validateEnvRows(all);
    if (!result.ok) {
      setRows(all);
      setDraft({ key: "", value: "" });
      setErrors(result.errors);
      return;
    }
    setErrors([]);
    try {
      const saved = await api.saveEnv(result.variables);
      if (saved.ok) {
        // R25-5: env changes have no other visible effect, so Save confirms it and says when it applies.
        store.getState().setStatusMessage(strings.env.saved(Object.keys(result.variables).length));
        close();
      } else {
        setStatus(strings.env.saveFailed(saved.error));
      }
    } catch (error) {
      // R-M3-T25-SAVE-1: a rejected save (e.g. InvalidPayloadError) must never become an unhandled rejection
      // or strand the sheet; keep the rows and show the same message a handled failure would.
      setStatus(strings.env.saveFailed(error instanceof Error ? error.message : String(error)));
    }
  };
  const errorFor = (index: number) => errors.find((entry) => entry.index === index)?.error;
  const errorTextFor = (index: number, row: EnvRow): string | undefined => {
    const error = errorFor(index);
    if (!error) return undefined;
    if (error === "invalidKey" || error === "duplicateKey") return strings.env.errors[error];
    if (error === "valueTooLong") return strings.env.valueTooLong(row.key, MAX_ENV_VALUE_CHARS);
    return strings.env.tooMany(MAX_ENV_VARS);
  };
  const dirty = loaded && (JSON.stringify(rowsToVariables(rows)) !== initial.current || draft.key.trim() !== "");

  return (
    <div className="dialog-backdrop">
      {/* biome-ignore lint/a11y/noStaticElementInteractions: keyboard shortcuts for the whole sheet (Escape, ⌘↵) */}
      <div
        ref={sheetRef}
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={strings.env.title}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            close();
          } else if (event.key === "Enter" && event.metaKey) {
            event.preventDefault();
            void save();
          }
        }}
      >
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
            {rows.map((row, index) => (
              <tr key={row.id} className={errorFor(index) ? "invalid" : undefined}>
                <td>
                  <input
                    aria-label={strings.env.keyOf(index + 1)}
                    aria-invalid={Boolean(errorFor(index))}
                    aria-describedby={errorFor(index) ? `env-error-${row.id}` : undefined}
                    value={row.key}
                    onChange={(event) =>
                      setRows((current) => updateEnvRow(current, row.id, { key: event.target.value }))
                    }
                  />
                  {errorFor(index) && (
                    <span id={`env-error-${row.id}`} className="env-error">
                      {errorTextFor(index, row)}
                    </span>
                  )}
                </td>
                <td className="env-value">
                  <input
                    aria-label={strings.env.valueOf(row.key)}
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
            ))}
            <tr className="env-new">
              <td>
                <input
                  ref={newKey}
                  aria-label={strings.env.newKey}
                  placeholder={strings.env.key}
                  value={draft.key}
                  onChange={(event) => setDraft({ ...draft, key: event.target.value })}
                  onPaste={(event) => {
                    // R25-3: moving a project's .env into the table takes one paste instead of many fields.
                    const next = rowsFromPaste(rows, event.clipboardData.getData("text"));
                    if (next) {
                      event.preventDefault();
                      setRows(next);
                      setStatus(strings.env.pasted(next.length - rows.length));
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
              <td>
                <input
                  ref={newValue}
                  aria-label={strings.env.newValue}
                  placeholder={strings.env.value}
                  value={draft.value}
                  onChange={(event) => setDraft({ ...draft, value: event.target.value })}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.metaKey) {
                      event.preventDefault();
                      add();
                    }
                  }}
                />
              </td>
              <td>
                <button type="button" onClick={add}>
                  {strings.env.add}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
        {status && (
          <p className="sheet-status" role="alert">
            {status}
          </p>
        )}
        <div className="dialog-actions">
          {dirty && <span className="sheet-status">{strings.tabs.unsaved}</span>}
          <button type="button" onClick={close}>
            {strings.env.cancel}
          </button>
          <button type="button" className="primary" disabled={!loaded} onClick={() => void save()}>
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
