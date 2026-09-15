import { useEffect, useRef, useState } from "react";
import { strings } from "../strings";
import { npmrcWarnings } from "./npmrc-lint";
import type { SettingsApi } from "./settings-rpc";

export interface TextEditorLike {
  getValue(): string;
  setValue(value: string): void;
  onChange(listener: () => void): () => void;
  dispose(): void;
}

export type CreateTextEditor = (host: HTMLElement, value: string) => Promise<TextEditorLike>;

export interface NpmrcEditorHandle {
  content(): string;
  dirty(): boolean;
  status(): string | null;
  set(content: string): void;
  save(): Promise<void>;
  reset(): Promise<void>;
}

type Status = { kind: "ok" | "error"; text: string };

const createMonacoEditor: CreateTextEditor = async (host, value) =>
  (await import("./npmrc-monaco")).createNpmrcMonaco(host, value);

/** Settings → NPM (spec §11.5): the `<packages>/.npmrc` editor with Save and Reset. */
export function NpmrcEditor({
  api,
  createEditor = createMonacoEditor,
  onReady,
}: {
  api: Pick<SettingsApi, "getNpmrc" | "saveNpmrc" | "resetNpmrc">;
  createEditor?: CreateTextEditor;
  onReady?(handle: NpmrcEditorHandle | null): void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<TextEditorLike | null>(null);
  // Set right before a programmatic setValue (Reset), so the following onChange doesn't mark the fresh content
  // dirty — Monaco (and the test fake) fire onChange for both user typing and setValue alike.
  const suppressNext = useRef(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [status, setStatus] = useState<Status | null>(null);
  // R27-1: the first Reset click only asks for confirmation; the second (Confirm Reset) commits it.
  const [confirmReset, setConfirmReset] = useState(false);
  const latest = useRef({ saved, text, status });
  latest.current = { saved, text, status };

  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | null = null;
    void api.getNpmrc().then(
      async (content) => {
        if (disposed || !host.current) return;
        const created = await createEditor(host.current, content);
        if (disposed) {
          created.dispose();
          return;
        }
        editor.current = created;
        setSaved(content);
        setText(content);
        stop = created.onChange(() => {
          const next = created.getValue();
          setText(next);
          setConfirmReset(false);
          if (suppressNext.current) {
            suppressNext.current = false;
            return;
          }
          // R27-2: an edit clears whatever status was shown and, while the text differs from what's saved, shows
          // the same "Unsaved changes" marker used elsewhere in Settings.
          setStatus(next === latest.current.saved ? null : { kind: "ok", text: strings.tabs.unsaved });
        });
      },
      () => setStatus({ kind: "error", text: strings.settings.npmrc.loadFailed }),
    );
    return () => {
      disposed = true;
      stop?.();
      editor.current?.dispose();
      editor.current = null;
    };
  }, [api, createEditor]);

  const save = async () => {
    setConfirmReset(false);
    const content = editor.current?.getValue() ?? latest.current.text;
    try {
      const result = await api.saveNpmrc(content);
      if (result.ok) {
        setSaved(content);
        setStatus({ kind: "ok", text: strings.settings.npmrc.saved });
      } else {
        setStatus({ kind: "error", text: strings.settings.npmrc.saveFailed(result.error) });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus({ kind: "error", text: strings.settings.npmrc.saveFailed(message) });
    }
  };

  // N1-1 (parked T18 N-1): Main's npmrc.reset has no rejection handler, so a write failure rejects this promise. A
  // rejection here must never surface the raw error (which can carry an absolute path) and must leave the editor's
  // content exactly as it was.
  const reset = async () => {
    setConfirmReset(false);
    try {
      const content = await api.resetNpmrc();
      suppressNext.current = true;
      editor.current?.setValue(content);
      setSaved(content);
      setText(content);
      setStatus({ kind: "ok", text: strings.settings.npmrc.resetDone });
    } catch {
      setStatus({ kind: "error", text: strings.settings.npmrc.resetFailed });
    }
  };

  useEffect(() => {
    if (saved === null) return;
    onReady?.({
      content: () => editor.current?.getValue() ?? latest.current.text,
      dirty: () => (editor.current?.getValue() ?? latest.current.text) !== latest.current.saved,
      status: () => latest.current.status?.text ?? null,
      set: (content) => editor.current?.setValue(content),
      save,
      reset,
    });
    return () => onReady?.(null);
  });

  const warnings = npmrcWarnings(text);
  const saveDisabled = saved === null || text === saved;

  return (
    <section className="npmrc">
      <h2>{strings.settings.npmrc.title}</h2>
      <p className="field-help">{strings.settings.npmrc.help}</p>
      {/* biome-ignore lint/a11y/useSemanticElements: hosts the Monaco (or a fake) text editor instance; it isn't a form */}
      <div ref={host} className="npmrc-editor" role="group" aria-label={strings.settings.npmrc.editorLabel} />
      {warnings.length > 0 && (
        <ul className="npmrc-warnings">
          {warnings.map((warning) => (
            <li key={`${warning.line}-${warning.message}`}>
              {strings.settings.npmrc.warnings[warning.message](warning.line)}
            </li>
          ))}
        </ul>
      )}
      <details className="npmrc-examples">
        <summary>{strings.settings.npmrc.examples}</summary>
        <pre>{strings.settings.npmrc.exampleText}</pre>
        <p className="field-help">{strings.settings.npmrc.privacyNote}</p>
      </details>
      <div className="settings-actions">
        {confirmReset ? (
          <button type="button" className="danger" onClick={() => void reset()}>
            {strings.settings.confirmReset}
          </button>
        ) : (
          <button type="button" onClick={() => setConfirmReset(true)}>
            {strings.settings.npmrc.reset}
          </button>
        )}
        <button type="button" disabled={saveDisabled} onClick={() => void save()}>
          {strings.settings.npmrc.save}
        </button>
        {status && (
          <span
            className={status.kind === "error" ? "npmrc-status npmrc-status-error" : "npmrc-status"}
            role={status.kind === "error" ? "alert" : "status"}
          >
            {status.text}
          </span>
        )}
      </div>
    </section>
  );
}
