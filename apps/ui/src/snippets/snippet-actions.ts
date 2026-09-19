import type { MainApi } from "../api";
import type { CommandSpec } from "../commands/registry";
import type { EditorHandle } from "../editor/editor-handle";
import type { AppStore } from "../state/store";
import type { TabActions } from "../tabs/tab-actions";
import type { SnippetActions } from "./SnippetsPanel";
import { expansionFor, plainInsertion, snippetTemplate } from "./snippet-text";

/**
 * What the panel's own buttons need. Deliberately free of side-bar control, so `App.tsx` can build this above the
 * `registry` memo without a forward reference to it (ruling R-M5b-D3/D4-FIX-b).
 */
export interface SnippetActionDeps {
  store: AppStore;
  editor(): EditorHandle | null;
  tabs: Pick<TabActions, "newTab">;
}

export interface SnippetCommandDeps extends SnippetActionDeps {
  api: Pick<MainApi, "snippetsImportDialog" | "snippetsExportDialog">;
  /** True when the side bar is open and showing the Snippets panel right now. */
  panelShowing(): boolean;
  /** Show the Snippets panel (a no-op when it already is). Never a toggle. */
  openPanel(): void;
  /** Hide the side bar. */
  closePanel(): void;
}

export function createSnippetActions(deps: SnippetActionDeps): SnippetActions & {
  canExpandAtCursor(): boolean;
  expandAtCursor(): boolean;
  /** Spec §13.1 Create Snippet…: the selection, or the whole buffer. Null when no editor is mounted. */
  selectionForNewSnippet(): string | null;
} {
  const expansion = () => {
    const editor = deps.editor();
    return editor ? expansionFor(editor.textBeforeCursor(), deps.store.getState().snippets) : null;
  };

  const put = (body: string, deleteBefore: number) => {
    const editor = deps.editor();
    if (!editor) return;
    // Spec §13.2: a body with tab stops goes in as a template; one without has its $ escaped.
    if (editor.insertSnippet(snippetTemplate(body), deleteBefore)) return;
    // No snippet controller: type the literal rendering instead, which still replaces the selection.
    editor.typeText(plainInsertion(body), false);
  };

  return {
    insert: (snippet) => put(snippet.body, 0),
    insertInNewTab: async (snippet) => {
      // A fresh buffer has nowhere to put tab stops, so the new tab gets the literal text.
      await deps.tabs.newTab({
        content: plainInsertion(snippet.body),
        ...(snippet.language ? { language: snippet.language } : {}),
      });
    },
    canExpandAtCursor: () => expansion() !== null,
    expandAtCursor: () => {
      const found = expansion();
      if (!found) return false;
      put(found.snippet.body, found.deleteBefore);
      return true;
    },
    selectionForNewSnippet: () => deps.editor()?.selectedTextOrAll() ?? null,
  };
}

/**
 * Spec §13 and §6.5. Registered by `App.tsx` inside its `registry` memo, so `openPanel` / `closePanel` can route
 * through the `view.toggleSideBar` command -- `view.sideBar` keeps exactly one writer (ruling R-M5b-D3/D4-FIX-a,
 * following the precedent M5a set for `view.showTranspiled` in the same file).
 */
export function createSnippetCommands(deps: SnippetCommandDeps): CommandSpec[] {
  const actions = createSnippetActions(deps);
  const s = () => deps.store.getState();
  const show = () => {
    deps.openPanel();
    s().requestSnippets("focusSearch");
  };

  return [
    {
      id: "tools.snippets",
      // The same three-way behaviour the activity-bar button has, so key and click never diverge (R-M5b-3).
      run: () => (deps.panelShowing() ? deps.closePanel() : show()),
    },
    {
      id: "snippets.create",
      isEnabled: () => deps.editor() !== null,
      run: () => {
        const body = actions.selectionForNewSnippet();
        if (body === null) return;
        deps.openPanel();
        s().requestSnippets("newSnippet", body);
      },
    },
    {
      // The panel opens first: Main answers with a `snippets.imported` message, which only a mounted panel hears.
      id: "snippets.import",
      run: () => {
        deps.openPanel();
        deps.api.snippetsImportDialog();
      },
    },
    {
      id: "snippets.export",
      run: () => {
        deps.openPanel();
        deps.api.snippetsExportDialog(s().snippets);
      },
    },
    {
      id: "snippets.expand",
      // This is what keeps a bare-Tab binding safe (App.tsx skips preventDefault for a disabled command).
      isEnabled: () => actions.canExpandAtCursor(),
      run: () => void actions.expandAtCursor(),
    },
  ];
}
