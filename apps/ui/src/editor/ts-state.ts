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

/**
 * True only when the *same* shown tab's working directory changed between two states (Task 23 fix round 2, I-1). A
 * tab switch is deliberately never a working-directory change, even when the newly shown tab's working directory
 * differs from the previously shown tab's: `state.tab` mirrors whichever tab is active, so naively comparing it
 * across a switch would wipe the new tab's still-valid local files and package types for no reason.
 */
export function workingDirectoryChanged(
  state: Pick<AppState, "activeTabId" | "tabs">,
  previous: Pick<AppState, "activeTabId" | "tabs">,
): boolean {
  if (state.activeTabId === null || state.activeTabId !== previous.activeTabId) return false;
  const next = state.tabs[state.activeTabId]?.workingDirectory ?? null;
  const prev = previous.tabs[state.activeTabId]?.workingDirectory ?? null;
  return next !== prev;
}
