import {
  emptyParamsSchema,
  type TabCloseResult,
  type TabWithContent,
  tabCreateParamsSchema,
  tabParamsSchema,
  tabReorderSchema,
  tabViewStateSchema,
} from "@jslab/rpc-schema";
import type { TabState } from "@jslab/shared";
import type { RunCoordinator } from "../runs/run-coordinator";
import type { SparePool } from "../runs/spare-pool";
import type { SessionStore } from "../services/session-store";
import { createValidators, type Log } from "./validate";

export interface WorkspaceHandlerDeps {
  session: Pick<
    SessionStore,
    "session" | "createTab" | "closeTab" | "reopenClosed" | "activateTab" | "reorderTabs" | "setViewState"
  >;
  coordinator: Pick<RunCoordinator, "disposeTab">;
  spares: Pick<SparePool, "setActiveTab">;
  log: Log;
}

type Handlers = {
  requests: Record<string, (input: never) => unknown>;
  messages: Record<string, (input: never) => void>;
};

/** Combines handler groups for one BrowserView RPC; a method name may exist in only one group. */
export function mergeHandlers<T extends Handlers[]>(...groups: T) {
  const requests: Record<string, unknown> = {};
  const messages: Record<string, unknown> = {};
  for (const group of groups) {
    for (const [target, source] of [
      [requests, group.requests],
      [messages, group.messages],
    ] as const) {
      for (const [name, handler] of Object.entries(source)) {
        if (name in target) throw new Error(`Duplicate RPC handler: ${name}`);
        target[name] = handler;
      }
    }
  }
  return { requests, messages } as {
    requests: UnionToIntersection<T[number]["requests"]>;
    messages: UnionToIntersection<T[number]["messages"]>;
  };
}

type UnionToIntersection<U> = (U extends unknown ? (x: U) => void : never) extends (x: infer I) => void ? I : never;

/** Tab lifecycle (spec §7.3, §10.1). Settings requests live in settings-handlers.ts. */
export function createWorkspaceHandlers(deps: WorkspaceHandlerDeps) {
  const { parse, message } = createValidators(deps.log);
  return {
    requests: {
      // parse runs synchronously before any await, so an invalid payload throws InvalidPayloadError instead of
      // returning a rejected promise.
      "tab.create": (input: unknown): Promise<{ tab: TabState }> => {
        const options = parse(tabCreateParamsSchema, "tab.create", input);
        return deps.session.createTab(options).then((tab) => {
          deps.spares.setActiveTab(deps.session.session.activeTabId);
          return { tab };
        });
      },
      "tab.close": async (input: unknown): Promise<TabCloseResult> => {
        const { tabId } = parse(tabParamsSchema, "tab.close", input);
        deps.coordinator.disposeTab(tabId);
        const result = await deps.session.closeTab(tabId);
        deps.spares.setActiveTab(result.activeTabId);
        return {
          ok: true,
          activeTabId: result.activeTabId,
          replacement: result.replacement ? { tab: result.replacement, content: "" } : null,
        };
      },
      "tab.reopen": (input: unknown): Promise<TabWithContent | null> => {
        parse(emptyParamsSchema, "tab.reopen", input);
        return deps.session.reopenClosed().then((reopened) => {
          deps.spares.setActiveTab(deps.session.session.activeTabId);
          return reopened;
        });
      },
    },
    messages: {
      "tab.activate": message(tabParamsSchema, "tab.activate", ({ tabId }) => {
        deps.session.activateTab(tabId);
        // The store ignores unknown ids, so warm whatever tab is active now.
        deps.spares.setActiveTab(deps.session.session.activeTabId);
      }),
      "tab.reorder": message(tabReorderSchema, "tab.reorder", ({ tabOrder }) => deps.session.reorderTabs(tabOrder)),
      "tab.viewState": message(tabViewStateSchema, "tab.viewState", ({ tabId, viewState }) =>
        deps.session.setViewState(tabId, viewState),
      ),
    },
  };
}
