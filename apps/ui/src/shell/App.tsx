import { MAX_TEXT_CHARS } from "@jslab/rpc-schema";
import { commandMeta, DEFAULT_KEYBINDINGS, resolveKeybindings } from "@jslab/shared";
import { useCallback, useEffect, useMemo } from "react";
import { useStore } from "zustand";
import type { MainApi } from "../api";
import { createAppCommands } from "../commands/app-commands";
import { createEditorCommands, EDITOR_ACTIONS } from "../commands/editor-commands";
import { CommandRegistry } from "../commands/registry";
import { createE2EAgent } from "../e2e/agent";
import { Editor } from "../editor/Editor";
import { getEditorHandle } from "../editor/editor-handle";
import { contextFromState, KeybindingResolver } from "../keybindings/resolver";
import { OutputPanel } from "../output/OutputPanel";
import { startAutoRun } from "../state/auto-run";
import type { AppStore } from "../state/store";
import { strings } from "../strings";
import { createTabActions } from "../tabs/tab-actions";
import { ActivityBar, SafeModeBanner, SplitPane, StartupNotices, StatusBar, UnresponsiveDialog } from "./parts";

const UI_HEARTBEAT_MS = 2000;

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
      if (state.code.length > MAX_TEXT_CHARS) {
        // Main would reject a run.start this large (MAX_TEXT_CHARS); say so instead of failing silently.
        state.setStatusMessage(strings.limits.tooLarge);
        return;
      }
      void api.startRun({ tabId: state.tab.id, code: state.code, language: state.tab.language, logpoints: [], reason });
    },
    [store, api],
  );

  const tabs = useMemo(() => createTabActions(store, api), [store, api]);

  const registry = useMemo(() => {
    const created = new CommandRegistry((id, error) =>
      store.getState().setStatusMessage(strings.commands.failed(commandMeta(id)?.title ?? id, error)),
    );
    created.register(
      ...createAppCommands({ store, api, tabs, run: () => run("manual"), editor: getEditorHandle }),
      ...createEditorCommands(getEditorHandle),
    );
    return created;
  }, [store, api, tabs, run]);

  const resolver = useMemo(
    () => new KeybindingResolver(resolveKeybindings(DEFAULT_KEYBINDINGS, store.getState().keybindings)),
    [store],
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
      api.on("menu.command", ({ command }) => {
        registry.execute(command);
      }),
      api.on("settings.changed", ({ settings }) => store.getState().updateSettings(settings)),
    ];
    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
  }, [store, api, registry]);

  useEffect(() => {
    if (!e2e) return;
    const agent = createE2EAgent({
      store,
      editor: getEditorHandle,
      target: () => document.activeElement ?? document.body,
      executeCommand: (id, args) => registry.execute(id, args),
      missingEditorActions: () => getEditorHandle()?.missingActions(Object.values(EDITOR_ACTIONS)) ?? [],
    });
    return api.on("e2e.request", ({ reqId, method, params }) => {
      agent(method, params).then(
        (result) => api.e2eRespond({ reqId, ok: true, result }),
        (error: unknown) =>
          api.e2eRespond({ reqId, ok: false, error: error instanceof Error ? error.message : String(error) }),
      );
    });
  }, [e2e, store, api, registry]);

  useEffect(
    () =>
      store.subscribe((state, previous) => {
        for (const id of state.tabOrder) {
          const next = state.tabs[id];
          const before = previous.tabs[id];
          if (!next || !before) continue;
          if (state.buffers[id] !== previous.buffers[id]) {
            const content = state.buffers[id] ?? "";
            // Main rejects buffer.changed above MAX_TEXT_CHARS. Tell the user rather than dropping the edit silently.
            if (content.length > MAX_TEXT_CHARS) store.getState().setStatusMessage(strings.limits.tooLarge);
            else api.bufferChanged(id, content);
          }
          // updateLayout (state/store.ts) always replaces the layout object, even when the clamped
          // fields end up the same (a divider drag past 10/90, or a reset to the current split), so
          // compare fields rather than the object reference (fix round 1, I-1).
          const layoutChanged =
            next.layout.orientation !== before.layout.orientation ||
            next.layout.editorSize !== before.layout.editorSize ||
            next.layout.outputVisible !== before.layout.outputVisible;
          if (
            next.language !== before.language ||
            next.runtime !== before.runtime ||
            layoutChanged ||
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
    // Capture phase, so shortcuts win over Monaco and WKWebView defaults (for example Cmd+R reload).
    const onKeyDown = (event: KeyboardEvent) => {
      const context = contextFromState(
        store.getState(),
        document.activeElement,
        getEditorHandle()?.hasFocus() ?? false,
      );
      const command = resolver.resolve(event, context);
      if (!command || !registry.isEnabled(command)) return;
      event.preventDefault();
      event.stopPropagation();
      registry.execute(command);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [store, resolver, registry]);

  if (!tab) return null;
  const tabId = tab.id;

  return (
    <div className="app">
      {safeMode.active && <SafeModeBanner reason={safeMode.reason} />}
      <StartupNotices notices={notices} onDismiss={(id) => store.getState().dismissNotice(id)} />
      <div className="app-main">
        <ActivityBar
          runState={runState}
          onRun={() => registry.execute("run.start")}
          onStop={() => registry.execute("run.stop")}
        />
        <SplitPane
          orientation={tab.layout.orientation}
          size={tab.layout.editorSize}
          onResize={(size) => store.getState().setEditorSize(size)}
          first={<Editor store={store} api={api} />}
          second={<OutputPanel store={store} api={api} />}
        />
      </div>
      <StatusBar store={store} />
      {runState === "unresponsive" && (
        <UnresponsiveDialog onKill={() => registry.execute("run.kill")} onWait={() => api.wait(tabId)} />
      )}
    </div>
  );
}
