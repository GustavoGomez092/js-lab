import type { AppState } from "../state/store";
import type { TsEnvironmentState } from "./ts-environment";

/** What the editor's TypeScript environment must match: the shown tab and two settings (spec §6.1). */
export function tsStateFor(state: Pick<AppState, "activeTabId" | "tabs" | "settings">): TsEnvironmentState | null {
  const tab = state.activeTabId ? state.tabs[state.activeTabId] : undefined;
  if (!tab || !state.settings) return null;
  return {
    tabId: tab.id,
    runtime: tab.runtime,
    decorators: state.settings.build.decorators,
    linting: state.settings.editor.linting,
  };
}
