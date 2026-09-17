import type { Language } from "@jslab/shared";
import type * as Monaco from "monaco-editor";

/** The form's view of its body field, whatever is behind it. */
export interface SnippetBodyHandle {
  getValue(): string;
  focus(): void;
  dispose(): void;
}

export type SnippetBodyFactory = (
  host: HTMLElement,
  options: { value: string; language: Language | null },
) => SnippetBodyHandle;

/**
 * Spec §13.1: "Body (a Monaco editor)". `monaco` and `languageId` are parameters rather than imports, so this module
 * carries no Monaco runtime dependency and the snippets folder stays loadable under happy-dom (R-M5b-5).
 *
 * `languageId` is injected rather than assumed because a JSLab `Language` is not a Monaco language id: `tsx` and
 * `jsx` are ours, and Monaco only knows `typescript` / `javascript`.
 */
export function createMonacoBody(
  monaco: typeof Monaco,
  languageId: (language: Language | null) => string,
): SnippetBodyFactory {
  return (host, { value, language }) => {
    const editor = monaco.editor.create(host, {
      value,
      language: languageId(language),
      automaticLayout: true,
      lineNumbers: "off",
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      folding: false,
      // A snippet body is code the user is authoring, so the usual editing affordances stay on; only the chrome goes.
      wordWrap: "on",
    });
    return {
      getValue: () => editor.getValue(),
      focus: () => editor.focus(),
      dispose: () => editor.dispose(),
    };
  };
}

/**
 * The fallback when no Monaco factory is injected: a real, labelled editing surface rather than a dead box. The
 * shipped app always passes `createMonacoBody` (Task 9), so this is reached only by a caller that opted out.
 */
export function createTextareaBody(label: string): SnippetBodyFactory {
  return (host, { value }) => {
    const field = host.ownerDocument.createElement("textarea");
    field.value = value;
    field.className = "snippets-body-field";
    field.setAttribute("aria-label", label);
    field.spellcheck = false;
    host.append(field);
    return {
      getValue: () => field.value,
      focus: () => field.focus(),
      dispose: () => field.remove(),
    };
  };
}
