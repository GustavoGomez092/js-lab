import type { TabCreateParams } from "@jslab/rpc-schema";
import { adjacentTabId, MAX_CLOSED_TABS } from "@jslab/shared";
import type { MainApi } from "../api";
import type { AppStore } from "../state/store";
import { gotoTabIndex } from "../state/workspace";
import { strings } from "../strings";

export interface TabActions {
  activate(tabId: string | null): void;
  newTab(params?: TabCreateParams): Promise<void>;
  /** Resolves true when the tab was closed. Task 18 adds the unsaved-changes and confirm-close prompts. */
  close(tabId?: string): Promise<boolean>;
  closeOthers(tabId?: string): Promise<void>;
  closeToRight(tabId?: string): Promise<void>;
  reopen(): Promise<void>;
  next(): void;
  previous(): void;
  goto(position: number): void;
}

/**
 * Runs `run`, reporting a rejection through the store instead of letting it reach the caller (T11-m4): every
 * tab action here is awaited by its caller (the command registry, or later a tab-bar click handler), so none
 * of them may resolve to an unhandled rejection. `fallback` is returned. The store is left exactly as it was
 * before `run` threw only when `run` rejects before mutating the store (as every action here does: it awaits
 * Main first and only then applies the result) -- this guard does not undo a store mutation that itself throws.
 */
async function guarded<T>(store: AppStore, run: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await run();
  } catch (error) {
    store.getState().setStatusMessage(strings.tabs.actionFailed(error));
    return fallback;
  }
}

export function createTabActions(store: AppStore, api: MainApi): TabActions {
  const s = () => store.getState();

  const activate = (tabId: string | null) => {
    if (!tabId || tabId === s().activeTabId || !s().tabs[tabId]) return;
    s().activateTab(tabId);
    api.activateTab(tabId);
  };

  const close = (tabId = s().activeTabId ?? undefined): Promise<boolean> => {
    if (!tabId) return Promise.resolve(false);
    const id = tabId;
    if (!s().tabs[id]) return Promise.resolve(false);
    return guarded(
      store,
      async () => {
        const result = await api.closeTab(id);
        const closing = s();
        // A stale or duplicate result for a tab the store no longer has is ignored outright (carried behavior,
        // ruling T8-m1): `ok: true` alone is never proof a tab was removed.
        if (!closing.tabs[id]) return false;
        // Only apply Main's chosen activeTabId while the closed tab is still the one showing; if the user
        // already switched away while the close was in flight, removeTab's own neighbor logic keeps the tab
        // they switched to instead of overriding it with Main's (now stale) choice.
        const stillActive = closing.activeTabId === id;
        closing.removeTab(id, result.replacement ? null : stillActive ? result.activeTabId : undefined);
        if (result.replacement) s().openTab(result.replacement.tab, result.replacement.content, true);
        const after = s();
        after.setClosedCount(Math.min(after.closedCount + 1, MAX_CLOSED_TABS));
        return true;
      },
      false,
    );
  };

  return {
    activate,
    newTab(params = {}) {
      return guarded(
        store,
        async () => {
          const { tab } = await api.createTab(params);
          s().openTab(tab, params.content ?? "", true);
        },
        undefined,
      );
    },
    close,
    async closeOthers(tabId = s().activeTabId ?? undefined) {
      if (!tabId) return;
      for (const id of s().tabOrder.filter((candidate) => candidate !== tabId)) {
        // A tab already gone from the store (closed by an earlier iteration, or elsewhere, while this loop
        // was awaiting) is not a refusal: skip it and keep going (m-2). Only a `close()` refused for a tab
        // that still exists stops the loop.
        if (!s().tabs[id]) continue;
        if (!(await close(id))) return;
      }
      activate(tabId);
    },
    async closeToRight(tabId = s().activeTabId ?? undefined) {
      if (!tabId) return;
      const order = s().tabOrder;
      for (const id of order.slice(order.indexOf(tabId) + 1)) {
        if (!s().tabs[id]) continue;
        if (!(await close(id))) return;
      }
    },
    reopen() {
      return guarded(
        store,
        async () => {
          const reopened = await api.reopenTab();
          if (!reopened) return;
          // Guard against a stale or duplicate reopen result (T11-oos1): if the tab is already in the store,
          // a previous (or concurrent) call already applied it, so re-adding it or decrementing again would
          // drift closedCount and duplicate the tab.
          if (s().tabs[reopened.tab.id]) return;
          const state = s();
          state.openTab(reopened.tab, reopened.content, true);
          state.setClosedCount(state.closedCount - 1);
        },
        undefined,
      );
    },
    next() {
      const id = s().activeTabId;
      if (id) activate(adjacentTabId(s().tabOrder, id, 1));
    },
    previous() {
      const id = s().activeTabId;
      if (id) activate(adjacentTabId(s().tabOrder, id, -1));
    },
    goto(position) {
      activate(gotoTabIndex(s().tabOrder, position));
    },
  };
}
