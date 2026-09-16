import type { MainMessages, MainRequests, ViewMessages } from "@jslab/rpc-schema";
import { Electroview, type RPCSchema } from "electrobun/view";
import type { MainApi } from "./api";
import { createViewMessageRouter } from "./view-messages";

type JSLabRPC = {
  bun: RPCSchema<{ requests: MainRequests; messages: MainMessages }>;
  webview: RPCSchema<{ requests: Record<string, never>; messages: ViewMessages }>;
};

/**
 * FB-m11: a save is an atomic write, fsync and `.bak` of up to 64 MB, possibly on a slow or network volume, and a
 * close may save first. Those requests get the Settings window's 60 s bound instead of the default 10 s, so the UI
 * doesn't report a failure while Main is still writing. Electrobun's request proxy takes a per-request
 * `maxRequestTime` option.
 */
export const SAVE_REQUEST_TIME_MS = 60_000;

/** Electrobun-backed implementation of MainApi. The only main-window UI module that imports Electrobun. */
export function createRpcApi(): MainApi {
  // Messages that arrive before App subscribes are queued and delivered once (T24-hub-main).
  const router = createViewMessageRouter();

  const rpc = Electroview.defineRPC<JSLabRPC>({
    maxRequestTime: 10_000,
    handlers: {
      requests: {},
      messages: router.handlers as never,
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
    stateFlushed: () => rpc.send["ui.stateFlushed"]({}),
    createTab: (params) => rpc.request["tab.create"](params),
    closeTab: (tabId) => rpc.request["tab.close"]({ tabId }, { maxRequestTime: SAVE_REQUEST_TIME_MS }),
    reopenTab: () => rpc.request["tab.reopen"]({}),
    activateTab: (tabId) => rpc.send["tab.activate"]({ tabId }),
    reorderTabs: (tabOrder) => rpc.send["tab.reorder"]({ tabOrder }),
    saveViewState: (tabId, viewState) => rpc.send["tab.viewState"]({ tabId, viewState }),
    updateSettings: (patch) => rpc.request["settings.update"]({ patch }),
    saveFile: (tabId, content) =>
      rpc.request["file.save"]({ tabId, content }, { maxRequestTime: SAVE_REQUEST_TIME_MS }),
    openFileDialog: () => rpc.send["file.openDialog"]({}),
    confirmLargeFiles: (tokens) => rpc.send["file.confirmLarge"]({ tokens }),
    saveAsDialog: (tabId, content) => rpc.send["file.saveAsDialog"]({ tabId, content }),
    confirmSaveAs: (token, confirmed) => rpc.send["file.confirmSaveAs"]({ token, confirmed }),
    revealInFinder: (tabId) => rpc.send["tab.revealInFinder"]({ tabId }),
    copyPath: (tabId) => rpc.send["tab.copyPath"]({ tabId }),
    npmList: (refreshOutdated) => rpc.request["npm.list"]({ refreshOutdated }),
    npmSearch: (query) => rpc.request["npm.search"]({ query }),
    npmInstall: (spec) => rpc.send["npm.install"]({ spec }),
    npmRemove: (name) => rpc.send["npm.remove"]({ name }),
    npmUpdate: (name) => rpc.send["npm.update"]({ name }),
    npmUpdateAll: () => rpc.send["npm.updateAll"]({}),
    packageTypes: (tabId, packages) =>
      rpc.request["types.package"]({ tabId, packages }).then((reply) => reply.packages),
    localTypes: (tabId, specifiers) => rpc.request["types.local"]({ tabId, specifiers }),
    getEnv: () => rpc.request["env.get"]({}).then((reply) => reply.variables),
    saveEnv: (variables) => rpc.request["env.save"]({ variables }),
    pickWorkingDirectory: (tabId) => rpc.send["wd.pick"]({ tabId }),
    clearWorkingDirectory: (tabId) => rpc.send["wd.clear"]({ tabId }),
    appCommand: (action) => rpc.send["app.command"]({ action }),
    e2eRespond: (response) => rpc.send["e2e.response"](response),
    webRunnerReady: (tabId) => rpc.send["webRunner.ready"]({ tabId }),
    webRunnerExit: (tabId) => rpc.send["webRunner.exit"]({ tabId }),
    webRunnerMessage: (tabId, raw) => rpc.send["webRunner.message"]({ tabId, raw }),
    on: (name, listener) => router.on(name, listener),
  };
}
