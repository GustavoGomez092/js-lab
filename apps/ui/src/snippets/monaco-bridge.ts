import type { Language } from "@jslab/shared";
import { strings } from "../strings";
import { createTextareaBody, type SnippetBodyFactory, type SnippetBodyHandle } from "./body-editor";
import type { SnippetColorize } from "./SnippetsPanel";

/**
 * The Monaco-dependent half of the snippets UI, published by `Editor.tsx` the same way `setEditorHandle` publishes
 * the editor itself. Nothing here imports Monaco, so `App.tsx` -> `SideBar` -> `SnippetsPanel` stays loadable under
 * happy-dom (`apps/ui/isolated/app.test.tsx` mocks only `../src/editor/Editor`).
 */
let slot: { colorize: SnippetColorize; createBody: SnippetBodyFactory } | null = null;

export function setSnippetMonaco(value: { colorize: SnippetColorize; createBody: SnippetBodyFactory } | null): void {
  slot = value;
}

/** Rejects while no editor is mounted; the panel then renders its plain-text preview (Task 7). */
export function snippetColorize(code: string, language: Language | null): Promise<string> {
  return slot ? slot.colorize(code, language) : Promise.reject(new Error("No editor is mounted"));
}

export function snippetBodyFactory(
  host: HTMLElement,
  options: { value: string; language: Language | null },
): SnippetBodyHandle {
  return (slot?.createBody ?? createTextareaBody(strings.snippets.bodyLabel))(host, options);
}
