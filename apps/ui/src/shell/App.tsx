import type { CommandId } from "@jslab/rpc-schema";
import { adjacentTabId } from "@jslab/shared";
import { useCallback, useEffect } from "react";
import { useStore } from "zustand";
import type { MainApi } from "../api";
import { createE2EAgent } from "../e2e/agent";
import { Editor } from "../editor/Editor";
import { getEditorHandle } from "../editor/editor-handle";
import { OutputPanel } from "../output/OutputPanel";
import { startAutoRun } from "../state/auto-run";
import type { AppStore } from "../state/store";
import { gotoTabIndex } from "../state/workspace";
import { commandForKey } from "./keys";
import { ActivityBar, SafeModeBanner, SplitPane, StartupNotices, StatusBar, UnresponsiveDialog } from "./parts";

const UI_HEARTBEAT_MS = 2000;

/** Commands the shell handles until Task 13's registry takes over. */
const SHELL_COMMANDS: ReadonlySet<string> = new Set([
  "run.start",
  "run.stop",
  "run.kill",
  "output.clear",
  "editor.clear",
  "help.copyDebugLog",
  "help.openLogsFolder",
  "help.restartSafeMode",
  "tab.new",
  "tab.close",
  "tab.reopenClosed",
  "tab.next",
  "tab.previous",
  ...Array.from({ length: 9 }, (_, i) => `tab.goto${i + 1}`),
]);

export function App({ store, api, e2e = false }: { store: AppStore; api: MainApi; e2e?: boolean }) {
  const tab = useStore(store, (s) => s.tab);
  const runState = useStore(store, (s) => s.output.runState);
  const safeMode = useStore(store, (s) => s.safeMode);
  const notices = useStore(store, (s) => s.notices);

  const run = useCallback(
    (reason: "auto" | "manual") => {
      const state = store.getState();
      if (!state.tab) return;
      if (reason === "manual") state.armAutoRun();
      void api.startRun({ tabId: state.tab.id, code: state.code, language: state.tab.language, logpoints: [], reason });
    },
    [store, api],
  );

  const activate = useCallback(
    (tabId: string | null) => {
      if (!tabId || tabId === store.getState().activeTabId) return;
      store.getState().activateTab(tabId);
      api.activateTab(tabId);
    },
    [store, api],
  );

  const execute = useCallback(
    (command: CommandId) => {
      const state = store.getState();
      const tabId = state.activeTabId;
      switch (command) {
        case "run.start":
          run("manual");
          return;
        case "run.stop":
          if (tabId) api.stop(tabId);
          return;
        case "run.kill":
          if (tabId) api.kill(tabId);
          return;
        case "output.clear":
          state.clearOutput();
          return;
        case "editor.clear":
          state.editCode("");
          return;
        case "help.copyDebugLog":
          api.appCommand("copyDebugLog");
          return;
        case "help.openLogsFolder":
          api.appCommand("openLogsFolder");
          return;
        case "help.restartSafeMode":
          api.appCommand("restartSafeMode");
          return;
        case "tab.new":
          void api.createTab({}).then(({ tab: created }) => store.getState().openTab(created, "", true));
          return;
        case "tab.close":
          if (!tabId) return;
          void api.closeTab(tabId).then((result) => {
            const s = store.getState();
            s.removeTab(tabId, result.replacement ? null : result.activeTabId);
            if (result.replacement) s.openTab(result.replacement.tab, result.replacement.content, true);
            s.setClosedCount(s.closedCount + 1);
          });
          return;
        case "tab.reopenClosed":
          void api.reopenTab().then((reopened) => {
            if (!reopened) return;
            const s = store.getState();
            s.openTab(reopened.tab, reopened.content, true);
            s.setClosedCount(s.closedCount - 1);
          });
          return;
        case "tab.next":
          if (tabId) activate(adjacentTabId(state.tabOrder, tabId, 1));
          return;
        case "tab.previous":
          if (tabId) activate(adjacentTabId(state.tabOrder, tabId, -1));
          return;
        default:
          if (command.startsWith("tab.goto")) activate(gotoTabIndex(state.tabOrder, Number(command.slice(8))));
      }
    },
    [store, api, run, activate],
  );

  useEffect(() => startAutoRun(store, () => run("auto")), [store, run]);

  useEffect(() => {
    const unsubscribers = [
      api.on("run.events", ({ tabId, runId, events }) => store.getState().receiveEvents(runId, events, tabId)),
      api.on("run.state", ({ tabId, runId, state, activeHandles }) =>
        store.getState().receiveState(runId, state, activeHandles, tabId),
      ),
      api.on("run.diagnostics", ({ tabId, runId, diagnostics }) =>
        store.getState().receiveDiagnostics(runId, diagnostics, tabId),
      ),
      api.on("menu.command", ({ command }) => execute(command)),
      api.on("settings.changed", ({ settings }) => store.getState().updateSettings(settings)),
    ];
    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
  }, [store, api, execute]);

  useEffect(() => {
    if (!e2e) return;
    const agent = createE2EAgent({
      store,
      editor: getEditorHandle,
      target: () => document.activeElement ?? document.body,
      executeCommand: (id) => {
        if (!SHELL_COMMANDS.has(id)) return false;
        execute(id as CommandId);
        return true;
      },
    });
    return api.on("e2e.request", ({ reqId, method, params }) => {
      agent(method, params).then(
        (result) => api.e2eRespond({ reqId, ok: true, result }),
        (error: unknown) =>
          api.e2eRespond({ reqId, ok: false, error: error instanceof Error ? error.message : String(error) }),
      );
    });
  }, [e2e, store, api, execute]);

  useEffect(
    () =>
      store.subscribe((state, previous) => {
        for (const id of state.tabOrder) {
          const next = state.tabs[id];
          const before = previous.tabs[id];
          if (!next || !before) continue;
          if (state.buffers[id] !== previous.buffers[id]) api.bufferChanged(id, state.buffers[id] ?? "");
          if (
            next.language !== before.language ||
            next.runtime !== before.runtime ||
            next.layout !== before.layout ||
            next.title !== before.title ||
            next.titleIsCustom !== before.titleIsCustom
          ) {
            api.patchTab(id, {
              language: next.language,
              runtime: next.runtime,
              layout: next.layout,
              title: next.title,
              titleIsCustom: next.titleIsCustom,
            });
          }
        }
      }),
    [store, api],
  );

  useEffect(() => {
    const timer = setInterval(() => api.heartbeat(), UI_HEARTBEAT_MS);
    return () => clearInterval(timer);
  }, [api]);

  useEffect(() => {
    // Capture phase so shortcuts win over Monaco and WKWebView defaults (for example Cmd+R reload).
    const onKeyDown = (event: KeyboardEvent) => {
      const command = commandForKey(event);
      if (!command) return;
      event.preventDefault();
      event.stopPropagation();
      execute(command);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [execute]);

  if (!tab) return null;
  const tabId = tab.id;

  return (
    <div className="app">
      {safeMode.active && <SafeModeBanner reason={safeMode.reason} />}
      <StartupNotices notices={notices} onDismiss={(id) => store.getState().dismissNotice(id)} />
      <div className="app-main">
        <ActivityBar runState={runState} onRun={() => execute("run.start")} onStop={() => execute("run.stop")} />
        <SplitPane
          orientation={tab.layout.orientation}
          size={tab.layout.editorSize}
          onResize={(size) => store.getState().setEditorSize(size)}
          first={<Editor store={store} />}
          second={<OutputPanel store={store} api={api} />}
        />
      </div>
      <StatusBar store={store} />
      {runState === "unresponsive" && (
        <UnresponsiveDialog onKill={() => execute("run.kill")} onWait={() => api.wait(tabId)} />
      )}
    </div>
  );
}
