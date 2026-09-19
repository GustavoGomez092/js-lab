import type { MainMessages, MainRequests, ViewMessages } from "@jslab/rpc-schema";
import { Electroview, type RPCSchema } from "electrobun/view";
import type { MainApi } from "./api";
import { DEFAULT_REQUEST_TIME_MS, requestOptions } from "./rpc-timeouts";
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
 *
 * Which requests those are is decided in `rpc-timeouts.ts`, not here: every request below passes
 * `requestOptions(method)`, so a new request cannot pick up the short default by being written without an option.
 */
export function createRpcApi(): MainApi {
  // Messages that arrive before App subscribes are queued and delivered once (T24-hub-main).
  const router = createViewMessageRouter();

  const rpc = Electroview.defineRPC<JSLabRPC>({
    maxRequestTime: DEFAULT_REQUEST_TIME_MS,
    handlers: {
      requests: {},
      messages: router.handlers as never,
    },
  });
  new Electroview({ rpc });

  return {
    bootstrap: () => rpc.request["app.bootstrap"]({}, requestOptions("app.bootstrap")),
    startRun: (params) => rpc.request["run.start"](params, requestOptions("run.start")),
    expand: (params) => rpc.request["run.expand"](params, requestOptions("run.expand")),
    transpiled: (tabId, hideInstrumentation) =>
      rpc.request["run.transpiled"]({ tabId, hideInstrumentation }, requestOptions("run.transpiled")),
    stop: (tabId) => rpc.send["run.stop"]({ tabId }),
    kill: (tabId) => rpc.send["run.kill"]({ tabId }),
    wait: (tabId) => rpc.send["run.wait"]({ tabId }),
    bufferChanged: (tabId, content) => rpc.send["buffer.changed"]({ tabId, content }),
    patchTab: (tabId, patch) => rpc.send["tab.patch"]({ tabId, patch }),
    heartbeat: () => rpc.send["ui.heartbeat"]({}),
    stateFlushed: () => rpc.send["ui.stateFlushed"]({}),
    createTab: (params) => rpc.request["tab.create"](params, requestOptions("tab.create")),
    closeTab: (tabId) => rpc.request["tab.close"]({ tabId }, requestOptions("tab.close")),
    reopenTab: () => rpc.request["tab.reopen"]({}, requestOptions("tab.reopen")),
    activateTab: (tabId) => rpc.send["tab.activate"]({ tabId }),
    reorderTabs: (tabOrder) => rpc.send["tab.reorder"]({ tabOrder }),
    saveViewState: (tabId, viewState) => rpc.send["tab.viewState"]({ tabId, viewState }),
    updateSettings: (patch) => rpc.request["settings.update"]({ patch }, requestOptions("settings.update")),
    importTheme: () => rpc.request["theme.import"]({}, requestOptions("theme.import")),
    importThemePick: (token, path) =>
      rpc.request["theme.importPick"]({ token, path }, requestOptions("theme.importPick")),
    saveFile: (tabId, content) => rpc.request["file.save"]({ tabId, content }, requestOptions("file.save")),
    openFileDialog: () => rpc.send["file.openDialog"]({}),
    confirmLargeFiles: (tokens) => rpc.send["file.confirmLarge"]({ tokens }),
    saveAsDialog: (tabId, content) => rpc.send["file.saveAsDialog"]({ tabId, content }),
    confirmSaveAs: (token, confirmed) => rpc.send["file.confirmSaveAs"]({ token, confirmed }),
    revealInFinder: (tabId) => rpc.send["tab.revealInFinder"]({ tabId }),
    copyPath: (tabId) => rpc.send["tab.copyPath"]({ tabId }),
    npmList: (refreshOutdated) => rpc.request["npm.list"]({ refreshOutdated }, requestOptions("npm.list")),
    npmSearch: (query) => rpc.request["npm.search"]({ query }, requestOptions("npm.search")),
    npmInstall: (spec) => rpc.send["npm.install"]({ spec }),
    npmRemove: (name) => rpc.send["npm.remove"]({ name }),
    npmUpdate: (name) => rpc.send["npm.update"]({ name }),
    npmUpdateAll: () => rpc.send["npm.updateAll"]({}),
    packageTypes: (tabId, packages) =>
      rpc.request["types.package"]({ tabId, packages }, requestOptions("types.package")).then(
        (reply) => reply.packages,
      ),
    localTypes: (tabId, specifiers) => rpc.request["types.local"]({ tabId, specifiers }, requestOptions("types.local")),
    getEnv: () => rpc.request["env.get"]({}, requestOptions("env.get")).then((reply) => reply.variables),
    saveEnv: (variables) => rpc.request["env.save"]({ variables }, requestOptions("env.save")),
    snippetsList: () =>
      rpc.request["snippets.list"]({}, requestOptions("snippets.list")).then((reply) => reply.snippets),
    // A library save is an atomic write with a .bak, like a file save, so it gets the longer bound (FB-m11) --
    // now decided in `rpc-timeouts.ts` with every other request, rather than spelled out at this one call site.
    snippetsSave: (snippets) => rpc.request["snippets.save"]({ snippets }, requestOptions("snippets.save")),
    snippetsImportDialog: () => rpc.send["snippets.importDialog"]({}),
    snippetsExportDialog: (snippets) => rpc.send["snippets.exportDialog"]({ snippets }),
    pickWorkingDirectory: (tabId) => rpc.send["wd.pick"]({ tabId }),
    clearWorkingDirectory: (tabId) => rpc.send["wd.clear"]({ tabId }),
    openExternal: (url) => rpc.send["link.open"]({ url }),
    aiSend: (params) => rpc.send["ai.send"](params),
    aiStop: (requestId) => rpc.send["ai.stop"]({ requestId }),
    aiSaveConversation: (messages) => rpc.send["ai.conversationSave"]({ messages }),
    appCommand: (action) => rpc.send["app.command"]({ action }),
    publishCommands: (ids) => rpc.send["commands.published"]({ ids }),
    e2eRespond: (response) => rpc.send["e2e.response"](response),
    webRunnerReady: (tabId, generation) => rpc.send["webRunner.ready"]({ tabId, generation }),
    webRunnerExit: (tabId, generation) => rpc.send["webRunner.exit"]({ tabId, generation }),
    webRunnerMessage: (tabId, raw) => rpc.send["webRunner.message"]({ tabId, raw }),
    on: (name, listener) => router.on(name, listener),
  };
}
