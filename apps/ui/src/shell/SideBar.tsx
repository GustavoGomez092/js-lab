import type { MainApi } from "../api";
import { TranspiledPanel } from "../output/TranspiledPanel";
import type { AppStore, SideBarPanel } from "../state/store";
import { strings } from "../strings";

/** Side bar host (spec §7.1). Snippets and AI Chat arrive later in M5; Transpiled Output ships in M5a (§7.4). */
export function SideBar({
  panel,
  store,
  api,
}: {
  panel: SideBarPanel;
  store: AppStore;
  api: Pick<MainApi, "transpiled">;
}) {
  if (panel === "transpiled") return <TranspiledPanel store={store} api={api} />;
  return (
    <aside className="side-bar" aria-label={panel === "snippets" ? strings.shell.snippets : strings.shell.aiChat}>
      <h2>{panel === "snippets" ? strings.shell.snippets : strings.shell.aiChat}</h2>
      <p>{strings.shell.sideBarPlaceholder}</p>
    </aside>
  );
}
