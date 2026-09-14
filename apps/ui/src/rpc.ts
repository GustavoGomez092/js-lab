import type { MainMessages, MainRequests, ViewMessages } from "@jslab/rpc-schema";
import { Electroview, type RPCSchema } from "electrobun/view";
import type { MainApi } from "./api";

type JSLabRPC = {
  bun: RPCSchema<{ requests: MainRequests; messages: MainMessages }>;
  webview: RPCSchema<{ requests: Record<string, never>; messages: ViewMessages }>;
};

type AnyListener = (payload: never) => void;

const VIEW_MESSAGES = [
  "run.events",
  "run.state",
  "run.diagnostics",
  "menu.command",
  "e2e.request",
  "settings.changed",
  "file.opened",
  "file.saved",
  "file.saveAsConfirm",
  "file.saveCancelled",
  "file.saveFailed",
  "app.notice",
] as const satisfies readonly (keyof ViewMessages)[];

// Type-level exhaustiveness check: a ViewMessages key missing from VIEW_MESSAGES fails typecheck here (m-5).
type MissingViewMessages = Exclude<keyof ViewMessages, (typeof VIEW_MESSAGES)[number]>;
const _allViewMessagesListed: [MissingViewMessages] extends [never] ? true : false = true;

/** Electrobun-backed implementation of MainApi. The only UI module that imports Electrobun. */
export function createRpcApi(): MainApi {
  const listeners = new Map<keyof ViewMessages, Set<AnyListener>>();
  const dispatch = (name: keyof ViewMessages) => (payload: unknown) => {
    for (const listener of listeners.get(name) ?? []) (listener as (p: unknown) => void)(payload);
  };

  const rpc = Electroview.defineRPC<JSLabRPC>({
    maxRequestTime: 10_000,
    handlers: {
      requests: {},
      messages: Object.fromEntries(VIEW_MESSAGES.map((name) => [name, dispatch(name)])) as never,
    },
  });
  new Electroview({ rpc });

  return {
    bootstrap: () => rpc.request["app.bootstrap"]({}),
    startRun: (params) => rpc.request["run.start"](params),
    expand: (params) => rpc.request["run.expand"](params),
    stop: (tabId) => rpc.send["run.stop"]({ tabId }),
    kill: (tabId) => rpc.send["run.kill"]({ tabId }),
    wait: (tabId) => rpc.send["run.wait"]({ tabId }),
    bufferChanged: (tabId, content) => rpc.send["buffer.changed"]({ tabId, content }),
    patchTab: (tabId, patch) => rpc.send["tab.patch"]({ tabId, patch }),
    heartbeat: () => rpc.send["ui.heartbeat"]({}),
    createTab: (params) => rpc.request["tab.create"](params),
    closeTab: (tabId) => rpc.request["tab.close"]({ tabId }),
    reopenTab: () => rpc.request["tab.reopen"]({}),
    activateTab: (tabId) => rpc.send["tab.activate"]({ tabId }),
    reorderTabs: (tabOrder) => rpc.send["tab.reorder"]({ tabOrder }),
    saveViewState: (tabId, viewState) => rpc.send["tab.viewState"]({ tabId, viewState }),
    updateSettings: (patch) => rpc.request["settings.update"]({ patch }),
    saveFile: (tabId, content) => rpc.request["file.save"]({ tabId, content }),
    openFileDialog: () => rpc.send["file.openDialog"]({}),
    confirmLargeFiles: (tokens) => rpc.send["file.confirmLarge"]({ tokens }),
    saveAsDialog: (tabId, content) => rpc.send["file.saveAsDialog"]({ tabId, content }),
    confirmSaveAs: (token, confirmed) => rpc.send["file.confirmSaveAs"]({ token, confirmed }),
    revealInFinder: (tabId) => rpc.send["tab.revealInFinder"]({ tabId }),
    copyPath: (tabId) => rpc.send["tab.copyPath"]({ tabId }),
    appCommand: (action) => rpc.send["app.command"]({ action }),
    e2eRespond: (response) => rpc.send["e2e.response"](response),
    on(name, listener) {
      const set = listeners.get(name) ?? new Set<AnyListener>();
      listeners.set(name, set);
      set.add(listener as AnyListener);
      return () => {
        set.delete(listener as AnyListener);
      };
    },
  };
}
