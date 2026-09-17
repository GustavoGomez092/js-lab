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

// F2: an fs error's message can carry an absolute path (`EACCES: permission denied, open '/Users/.../.npmrc'`).
// Only the leading error code is ever shown, never the raw message — the same rule N1-1 applies to a failed reset.
const ERROR_CODE = /^(E[A-Z0-9]+)(?=[:,\s]|$)/;

function extractErrorCode(message: string): string | null {
  const match = ERROR_CODE.exec(message);
  return match?.[1] ?? null;
}

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
  const confirmButton = useRef<HTMLButtonElement>(null);
  // Set right before a programmatic setValue (Reset), so the following onChange doesn't mark the fresh content
  // dirty — Monaco (and the test fake) fire onChange for both user typing and setValue alike.
  const suppressNext = useRef(false);
  // F3: guards against setting state after the component (the whole Settings window, in practice) unmounts while
  // a save or reset request is still in flight.
  const mounted = useRef(true);
  const [saved, setSaved] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [status, setStatus] = useState<Status | null>(null);
  // R27-1: the first Reset click only asks for confirmation; the second (Confirm Reset) commits it.
  const [confirmReset, setConfirmReset] = useState(false);
  // F3: while a save or reset request is in flight, both the Reset/Confirm Reset and Save buttons are disabled,
  // and a second save()/reset() call is a no-op.
  const [busy, setBusy] = useState<"save" | "reset" | null>(null);
  const latest = useRef({ saved, text, status });
  latest.current = { saved, text, status };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

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
      // F5: the load path used to discard the error entirely, so an oversized .npmrc and a permission-denied one
      // were indistinguishable here. Only the leading code is ever shown, never the raw message, for the same
      // reason a failed save shows only the code: an fs message can carry an absolute path.
      (error: unknown) =>
        setStatus({
          kind: "error",
          text: strings.settings.npmrc.loadFailed(
            extractErrorCode(error instanceof Error ? error.message : String(error)),
          ),
        }),
    );
    return () => {
      disposed = true;
      stop?.();
      editor.current?.dispose();
      editor.current = null;
    };
  }, [api, createEditor]);

  // F1: "Confirm Reset" disarms as soon as the user moves on without confirming — a pointerdown or focus change
  // outside the button itself, or the whole window losing focus. Document-level, because in WKWebView clicking a
  // button doesn't focus it, so a plain onBlur on the button would never fire.
  useEffect(() => {
    if (!confirmReset) return;
    const doc = host.current?.ownerDocument ?? document;
    const win = doc.defaultView;
    const disarm = (event: Event) => {
      const button = confirmButton.current;
      if (button && event.target instanceof Node && button.contains(event.target)) return;
      setConfirmReset(false);
    };
    const onWindowBlur = () => setConfirmReset(false);
    doc.addEventListener("pointerdown", disarm);
    doc.addEventListener("focusin", disarm);
    win?.addEventListener("blur", onWindowBlur);
    return () => {
      doc.removeEventListener("pointerdown", disarm);
      doc.removeEventListener("focusin", disarm);
      win?.removeEventListener("blur", onWindowBlur);
    };
  }, [confirmReset]);

  const save = async () => {
    if (busy) return;
    setBusy("save");
    setConfirmReset(false);
    const content = editor.current?.getValue() ?? latest.current.text;
    try {
      const result = await api.saveNpmrc(content);
      if (!mounted.current) return;
      if (result.ok) {
        setSaved(content);
        setStatus({ kind: "ok", text: strings.settings.npmrc.saved });
      } else {
        setStatus({ kind: "error", text: strings.settings.npmrc.saveFailed(extractErrorCode(result.error)) });
      }
    } catch (error) {
      if (!mounted.current) return;
      const message = error instanceof Error ? error.message : String(error);
      setStatus({ kind: "error", text: strings.settings.npmrc.saveFailed(extractErrorCode(message)) });
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  // N1-1 (parked T18 N-1): Main's npmrc.reset has no rejection handler, so a write failure rejects this promise. A
  // rejection here must never surface the raw error (which can carry an absolute path) and must leave the editor's
  // content exactly as it was.
  const reset = async () => {
    if (busy) return;
    setBusy("reset");
    setConfirmReset(false);
    try {
      const content = await api.resetNpmrc();
      if (!mounted.current) return;
      suppressNext.current = true;
      editor.current?.setValue(content);
      setSaved(content);
      setText(content);
      setStatus({ kind: "ok", text: strings.settings.npmrc.resetDone });
    } catch {
      if (!mounted.current) return;
      setStatus({ kind: "error", text: strings.settings.npmrc.resetFailed });
    } finally {
      if (mounted.current) setBusy(null);
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
  const saveDisabled = busy !== null || saved === null || text === saved;
  // F-NPMRC: a failed load leaves `saved` null, and Reset has to be as dead as Save is then. Otherwise its two
  // clicks write the default over a `.npmrc` that is present but unreadable -- the one file whose contents the
  // failed load deliberately refused to guess at.
  const resetAreaDisabled = busy !== null || saved === null;

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
          <button
            ref={confirmButton}
            type="button"
            className="danger"
            disabled={resetAreaDisabled}
            onClick={() => void reset()}
          >
            {strings.settings.confirmReset}
          </button>
        ) : (
          <button type="button" disabled={resetAreaDisabled} onClick={() => setConfirmReset(true)}>
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
