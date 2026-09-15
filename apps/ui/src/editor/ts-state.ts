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

/**
 * True when the TypeScript environment must be re-applied because the shown tab's runtime, or `build.decorators` or
 * `editor.linting`, changed between two states (Task 21 fix round 1, M-1/N-1).
 *
 * Deliberately ignores `tabId`: a tab switch always reaches `view.show` -> `onShown` -> `applyTypeScript` (a
 * different tab always has a different Monaco model, so `onShown` always runs and re-applies with the new tab's
 * local files), so comparing `tabId` here would only make every switch apply twice. When either state has no shown
 * tab, this returns false: `tsStateFor` is null there, so there is nothing to apply, and any transition into or out
 * of "no tab shown" still goes through `onShown` (a model swap to or from `null`).
 */
export function tsEnvironmentChanged(
  state: Pick<AppState, "activeTabId" | "tabs" | "settings">,
  previous: Pick<AppState, "activeTabId" | "tabs" | "settings">,
): boolean {
  const next = tsStateFor(state);
  const prev = tsStateFor(previous);
  if (!next || !prev) return false;
  return next.runtime !== prev.runtime || next.decorators !== prev.decorators || next.linting !== prev.linting;
}
