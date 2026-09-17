import type { Snippet } from "@jslab/shared";
import type * as Monaco from "monaco-editor";
import { completionsFor, snippetTemplate, triggerWord } from "./snippet-text";

/**
 * Spec §13.3: snippets whose name starts with the typed word, case-insensitively, with a snippet icon and the
 * description -- and still offered once the full name has been typed. Ruling R-M5b-7 adds the part the spec leaves
 * open: at that point the list collapses to the one exact match, instead of continuing to rank its longer siblings
 * the way VS Code's fuzzy suggest does (its issues #244170 and #66621).
 */
export function registerSnippetCompletions(
  monaco: typeof Monaco,
  deps: { snippets(): readonly Snippet[] },
): { dispose(): void } {
  return monaco.languages.registerCompletionItemProvider(["typescript", "javascript"], {
    provideCompletionItems: (model, position) => {
      // Only the text BEFORE the caret: the trailing half of `fe|tch()` is not part of the word being typed.
      const line = model.getValueInRange({
        startLineNumber: position.lineNumber,
        startColumn: 1,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      });
      const word = triggerWord(line);
      if (!word) return { suggestions: [] };
      const matches = completionsFor(word, deps.snippets());
      const range = new monaco.Range(
        position.lineNumber,
        position.column - word.length,
        position.lineNumber,
        position.column,
      );
      return {
        suggestions: matches.map((snippet, index) => ({
          label: snippet.name,
          kind: monaco.languages.CompletionItemKind.Snippet,
          detail: snippet.description,
          documentation: { value: snippet.body },
          insertText: snippetTemplate(snippet.body),
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          range,
          // A leading NUL keeps snippets above Monaco's word-based suggestions instead of intermixed with them
          // (R-M5b-7); the zero-padded index preserves `completionsFor`'s own order within the bucket. The padding
          // is what keeps an eleventh match from sorting between the first and the second.
          sortText: `${String.fromCharCode(0)}${String(index).padStart(4, "0")}${snippet.name}`,
        })),
      };
    },
  });
}
