import type { CommandId } from "@jslab/rpc-schema";
import { useCallback, useEffect } from "react";
import { useStore } from "zustand";
import type { MainApi } from "../api";
import { Editor } from "../editor/Editor";
import { OutputPanel } from "../output/OutputPanel";
import { startAutoRun } from "../state/auto-run";
import type { AppStore } from "../state/store";
import { commandForKey } from "./keys";
import { ActivityBar, SafeModeBanner, SplitPane, StatusBar, UnresponsiveDialog } from "./parts";

const UI_HEARTBEAT_MS = 2000;

export function App({ store, api }: { store: AppStore; api: MainApi }) {
  const tab = useStore(store, (s) => s.tab);
  const runState = useStore(store, (s) => s.output.runState);
  const safeMode = useStore(store, (s) => s.safeMode);

  const run = useCallback(
    (reason: "auto" | "manual") => {
      const state = store.getState();
      if (!state.tab) return;
      if (reason === "manual") state.armAutoRun();
      void api.startRun({ tabId: state.tab.id, code: state.code, language: state.tab.language, logpoints: [], reason });
    },
    [store, api],
  );

  const execute = useCallback(
    (command: CommandId) => {
      const tabId = store.getState().tab?.id;
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
          store.getState().clearOutput();
          return;
        case "editor.clear":
          store.getState().editCode("");
          return;
      }
    },
    [store, api, run],
  );

  useEffect(() => startAutoRun(store, () => run("auto")), [store, run]);

  useEffect(() => {
    const unsubscribers = [
      api.on("run.events", ({ runId, events }) => store.getState().receiveEvents(runId, events)),
      api.on("run.state", ({ runId, state, activeHandles }) =>
        store.getState().receiveState(runId, state, activeHandles),
      ),
      api.on("run.diagnostics", ({ runId, diagnostics }) => store.getState().receiveDiagnostics(runId, diagnostics)),
      api.on("menu.command", ({ command }) => execute(command)),
    ];
    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
  }, [store, api, execute]);

  useEffect(
    () =>
      store.subscribe((state, previous) => {
        if (!state.tab) return;
        if (state.code !== previous.code) api.bufferChanged(state.tab.id, state.code);
        if (
          previous.tab &&
          (state.tab.language !== previous.tab.language || state.tab.layout !== previous.tab.layout)
        ) {
          api.patchTab(state.tab.id, { language: state.tab.language, layout: state.tab.layout });
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
