import {
  isValidSnippetName,
  LANGUAGES,
  type Language,
  MAX_SNIPPET_DESCRIPTION_CHARS,
  newSnippet,
  type Snippet,
} from "@jslab/shared";
import { useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import type { MainApi } from "../api";
import type { AppStore } from "../state/store";
import { strings } from "../strings";
import { createTextareaBody, type SnippetBodyFactory, type SnippetBodyHandle } from "./body-editor";

interface FormProps {
  store: AppStore;
  api: Pick<MainApi, "snippetsSave">;
  /** The snippet being edited, or null for a new one. */
  initial: Snippet | null;
  /** The body to start from: the edited snippet's, or a selection from Create Snippet… (spec §13.1). */
  body: string;
  /**
   * The name a NEW snippet starts from. `Create "<query>"` seeds the search text here; without it that button
   * created an unnamed snippet and silently threw the query away (the defect Task 7 left open for this task).
   * Ignored when `initial` is set: an edit always shows the snippet's own name.
   */
  seedName?: string;
  onDone(): void;
  /** R-M5b-5: Monaco in the app, a stub in tests. Falls back to a labelled textarea when nothing is injected. */
  createBody?: SnippetBodyFactory;
  now?: () => string;
}

type NameError = "nameRequired" | "nameInvalid" | "nameTaken";

/** Spec §13.1's New Snippet form, reused for Edit. */
export function SnippetForm({ store, api, initial, body, seedName, onDone, createBody, now }: FormProps) {
  const snippets = useStore(store, (s) => s.snippets);
  const [name, setName] = useState(initial?.name ?? seedName ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [language, setLanguage] = useState<Language | "">(initial?.language ?? "");
  const [nameError, setNameError] = useState<NameError | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const handle = useRef<SnippetBodyHandle | null>(null);
  const nameField = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const element = host.current;
    // Unreachable at runtime -- refs are attached before effects run. It is what narrows `host.current` from
    // `HTMLDivElement | null` to the `HTMLElement` the factory takes: pinned by typecheck, not by any test.
    if (!element) return;
    const factory = createBody ?? createTextareaBody(strings.snippets.bodyLabel);
    handle.current = factory(element, { value: body, language: initial?.language ?? null });
    nameField.current?.focus();
    return () => {
      handle.current?.dispose();
      handle.current = null;
    };
    // The body field is created once per form instance; the panel remounts the form for every open (Task 7).
  }, [createBody, body, initial]);

  // Escape leaves the form, the same way every other JSLab surface does. Capture phase, on the document, so it
  // works even when focus sits inside Monaco, which swallows keys it handles itself (EnvVarsSheet's M-3 fix at
  // env/EnvVarsSheet.tsx:148 and ConfirmDialog's m-5 round, same reasoning).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onDone();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [onDone]);

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setNameError("nameRequired");
      return;
    }
    if (!isValidSnippetName(trimmed)) {
      setNameError("nameInvalid");
      return;
    }
    // Spec §13.1: names are unique. Both sides are folded, not just the typed one -- a library whose stored names
    // already carry capitals would otherwise accept a duplicate that Main then refuses (R-M5b-9, same rule the
    // panel's import conflict check follows). Renaming a snippet to the name it already has is not a conflict.
    const taken = snippets.some(
      (candidate) => candidate.id !== initial?.id && candidate.name.toLowerCase() === trimmed.toLowerCase(),
    );
    if (taken) {
      setNameError("nameTaken");
      return;
    }
    setNameError(null);
    setSaveError(null);

    const at = (now ?? (() => new Date().toISOString()))();
    // `?? body` is unreachable once mounted; it is what narrows the ref, like the guard in the effect above.
    const value = handle.current?.getValue() ?? body;
    const record: Snippet = initial
      ? {
          ...initial,
          name: trimmed,
          description: description.trim(),
          body: value,
          language: language || null,
          updatedAt: at,
        }
      : newSnippet({ name: trimmed, description, body: value, language: language || null }, () => at);
    // An edit replaces the record WHERE IT SITS: rebuilding the array around it would reorder the library.
    const next = initial
      ? snippets.map((candidate) => (candidate.id === initial.id ? record : candidate))
      : [...snippets, record];

    setSaving(true);
    try {
      const result = await api.snippetsSave(next);
      if (!result.ok) {
        setSaveError(strings.snippets.saveFailed(result.error));
        return;
      }
      // Pessimistic, like the panel's own save: the store only adopts what Main has confirmed.
      store.getState().receiveSnippets(next);
      onDone();
    } catch (error) {
      setSaveError(strings.snippets.saveFailed(error instanceof Error ? error.message : String(error)));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="snippets-form">
      <h2>{initial ? strings.snippets.editTitle : strings.snippets.newTitle}</h2>
      <label htmlFor="snippet-name">{strings.snippets.nameLabel}</label>
      <input
        id="snippet-name"
        ref={nameField}
        className="snippets-field"
        aria-invalid={nameError !== null}
        aria-describedby="snippet-name-help"
        autoComplete="off"
        spellCheck={false}
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <span id="snippet-name-help" className="snippets-help">
        {strings.snippets.nameHelp}
      </span>
      {nameError && (
        <span className="snippets-error" role="alert">
          {strings.snippets[nameError]}
        </span>
      )}
      <label htmlFor="snippet-description">{strings.snippets.descriptionLabel}</label>
      <input
        id="snippet-description"
        className="snippets-field"
        maxLength={MAX_SNIPPET_DESCRIPTION_CHARS}
        value={description}
        onChange={(event) => setDescription(event.target.value)}
      />
      <label htmlFor="snippet-language">{strings.snippets.languageLabel}</label>
      <select
        id="snippet-language"
        className="snippets-field"
        value={language}
        onChange={(event) => setLanguage(event.target.value as Language | "")}
      >
        <option value="">{strings.snippets.languageNone}</option>
        {LANGUAGES.map((option) => (
          <option key={option} value={option}>
            {strings.settings.options.language[option]}
          </option>
        ))}
      </select>
      <span className="snippets-help">{strings.snippets.bodyHelp}</span>
      <div ref={host} className="snippets-body" />
      {saveError && (
        <p className="snippets-status" role="alert">
          {saveError}
        </p>
      )}
      <div className="dialog-actions">
        <button type="button" onClick={onDone}>
          {strings.snippets.cancel}
        </button>
        <button type="button" className="primary" disabled={saving} onClick={() => void save()}>
          {strings.snippets.save}
        </button>
      </div>
    </div>
  );
}
