import { AiChatPanel, type AiCodeActions } from "../ai/AiChatPanel";
import type { MainApi } from "../api";
import { TranspiledPanel } from "../output/TranspiledPanel";
import type { SnippetBodyFactory } from "../snippets/body-editor";
import { type SnippetActions, type SnippetColorize, SnippetsPanel } from "../snippets/SnippetsPanel";
import type { AppState, AppStore } from "../state/store";
import { strings } from "../strings";
import type { Dialogs } from "./dialogs";

/**
 * Side bar host (spec §7.1). One independent early return per panel, so a milestone that adds a panel adds a line
 * and edits none. `panel` is typed as `AppState["sideBarPanel"]` rather than a union written here (ruling R-M5b-1),
 * so widening that union in `store.ts` never has to touch this signature.
 *
 * BOTH branches below are required, and NEITHER is enforced by the type system: `panel` is the whole union, so a
 * SideBar that has forgotten a member still compiles and silently renders the AI Chat placeholder for it. M5a owns
 * `transpiled` (spec §7.4), M5b owns `snippets` (spec §13.1). `apps/ui/test/transpiled-panel.test.tsx` is what makes
 * a dropped branch visible; see ruling R-M5b-D3/D4-FIX.
 */
export function SideBar({
  panel,
  store,
  api,
  dialogs,
  actions,
  aiActions,
  colorize,
  createBody,
}: {
  panel: AppState["sideBarPanel"];
  store: AppStore;
  api: MainApi;
  dialogs: Pick<Dialogs, "confirm">;
  actions: SnippetActions;
  /** Spec §14.1: what the AI panel's Insert at Cursor / Replace Editor buttons do. */
  aiActions: AiCodeActions;
  /** Filled by Task 10 through the Monaco bridge; absent in tests, where the preview falls back to plain text. */
  colorize?: SnippetColorize;
  createBody?: SnippetBodyFactory;
}) {
  if (panel === "transpiled") return <TranspiledPanel store={store} api={api} />;
  if (panel === "ai") {
    return <AiChatPanel store={store} api={api} actions={aiActions} {...(colorize ? { colorize } : {})} />;
  }
  if (panel === "snippets") {
    return (
      <SnippetsPanel
        store={store}
        api={api}
        dialogs={dialogs}
        actions={actions}
        colorize={colorize}
        createBody={createBody}
      />
    );
  }
  return (
    <aside className="side-bar" aria-label={strings.shell.aiChat}>
      <h2>{strings.shell.aiChat}</h2>
      <p>{strings.shell.sideBarPlaceholder}</p>
    </aside>
  );
}
