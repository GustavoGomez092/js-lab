import { appNoticeSchema, MAX_TEXT_CHARS } from "@jslab/rpc-schema";
import { commandMeta, DEFAULT_KEYBINDINGS, deriveTitle, resolveKeybindings } from "@jslab/shared";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useStore } from "zustand";
import type { MainApi } from "../api";
import { createAppCommands } from "../commands/app-commands";
import { createEditorCommands, EDITOR_ACTIONS } from "../commands/editor-commands";
import { createOutputCommands } from "../commands/output-commands";
import { CommandRegistry } from "../commands/registry";
import { createViewCommands } from "../commands/view-commands";
import { createE2EAgent } from "../e2e/agent";
import { Editor } from "../editor/Editor";
import { getEditorHandle } from "../editor/editor-handle";
import { createFileCommands } from "../files/file-commands";
import { createFileFlows } from "../files/file-flows";
import { createFormatActions } from "../format/format-actions";
import { type Formatter, shouldFormatBeforeRun } from "../format/formatter";
import { contextFromState, KeybindingResolver } from "../keybindings/resolver";
import { OutputPanel } from "../output/OutputPanel";
import { CommandPalette } from "../palette/CommandPalette";
import { startAutoRun } from "../state/auto-run";
import { createEventCoalescer } from "../state/event-coalescer";
import type { AppStore } from "../state/store";
import { strings } from "../strings";
import { RenameDialog } from "../tabs/RenameDialog";
import { TabBar } from "../tabs/TabBar";
import { createTabActions } from "../tabs/tab-actions";
import { startThemeSync } from "../themes/apply";
import { startAppearanceSync } from "../themes/fonts";
import { createThemeCommands } from "../themes/theme-commands";
import { ActivityBar } from "./ActivityBar";
import { ConfirmDialog } from "./ConfirmDialog";
import { createDialogs } from "./dialogs";
import { BUSY_STATES } from "./labels";
import { SafeModeBanner, StartupNotices, UnresponsiveDialog } from "./parts";
import { SideBar } from "./SideBar";
import { SplitPane } from "./SplitPane";
import { StatusBar } from "./StatusBar";
import { Toolbar } from "./Toolbar";

const UI_HEARTBEAT_MS = 2000;

/** Applies coalesced run events once per animation frame. Tests pass a synchronous scheduler. */
const defaultScheduleFrame = (callback: () => void) => {
  requestAnimationFrame(() => callback());
};

export function App({
  store,
  api,
  e2e = false,
  scheduleFrame = defaultScheduleFrame,
  formatter,
}: {
  store: AppStore;
  api: MainApi;
  e2e?: boolean;
  scheduleFrame?: (callback: () => void) => void;
  formatter?: Formatter;
}) {
  const tab = useStore(store, (s) => s.tab);
  const runState = useStore(store, (s) => s.output.runState);
  const safeMode = useStore(store, (s) => s.safeMode);
  const notices = useStore(store, (s) => s.notices);
  const settings = useStore(store, (s) => s.settings);
  const sideBarPanel = useStore(store, (s) => s.sideBarPanel);
  const tabCount = useStore(store, (s) => s.tabOrder.length);

  const lastTypedAt = useRef(0);
  // I-1: startAutoRun's cancelPending, kept current by the effect below. A format's own edit (applied
  // through Monaco) can arm a pending auto-run for the very code the run we're about to start already
  // covers; start() cancels it once the format has settled, before that timer can fire a duplicate run.
  const cancelPendingAutoRun = useRef<() => void>(() => {});
  const format = useMemo(
    () => (formatter ? createFormatActions({ store, formatter, editor: getEditorHandle }) : null),
    [store, formatter],
  );

  const run = useCallback(
    (reason: "auto" | "manual") => {
      const state = store.getState();
      if (!state.tab) return;
      // I-2: capture the tab this run is for. A format can take a noticeable time (worker cold start), and
      // the user can switch tabs while it runs; start() must still act on this tab, not whatever is active
      // once the format settles.
      const tabId = state.tab.id;
      if (reason === "manual") state.armAutoRun();
      const start = () => {
        cancelPendingAutoRun.current();
        const fresh = store.getState();
        const freshTab = fresh.tabs[tabId];
        if (!freshTab) return; // the tab closed while formatting; nothing left to run.
        const code = fresh.buffers[tabId] ?? "";
        if (code.length > MAX_TEXT_CHARS) {
          // Main would reject a run.start this large (MAX_TEXT_CHARS, Task 13); say so instead of failing silently.
          fresh.setStatusMessage(strings.limits.tooLarge);
          return;
        }
        void api.startRun({ tabId, code, language: freshTab.language, logpoints: [], reason });
      };
      const wantsFormat =
        format !== null &&
        shouldFormatBeforeRun({
          formatOnRun: Boolean(state.settings?.run.formatOnRun),
          editorFocused: getEditorHandle()?.hasFocus() ?? false,
          lastTypedAt: lastTypedAt.current,
          now: Date.now(),
        });
      // m-1: a rejected formatTab (for example a worker that fails to start) must not silently drop the run.
      if (wantsFormat && format) void format.formatTab(tabId).then(start, start);
      else start();
    },
    [store, api, format],
  );

  const tabs = useMemo(() => createTabActions(store, api), [store, api]);
  const coalescer = useMemo(
    () =>
      createEventCoalescer(
        (tabId, runId, events) => store.getState().receiveEvents(runId, events, tabId),
        scheduleFrame,
      ),
    [store, scheduleFrame],
  );
  const dialogs = useMemo(() => createDialogs(store), [store]);
  const flows = useMemo(
    () =>
      createFileFlows({
        store,
        api,
        tabs,
        dialogs,
        ...(format ? { beforeSave: async (tabId: string) => void (await format.formatTab(tabId)) } : {}),
      }),
    [store, api, tabs, dialogs, format],
  );

  // The close guard is a side effect, so it lives in an effect and is cleared on unmount (fix round 1, m-6).
  useEffect(() => {
    tabs.setBeforeClose((tabId) => flows.beforeClose(tabId));
    return () => tabs.setBeforeClose(null);
  }, [tabs, flows]);

  const registry = useMemo(() => {
    const created = new CommandRegistry((id, error) =>
      store.getState().setStatusMessage(strings.commands.failed(commandMeta(id)?.title ?? id, error)),
    );
    created.register(
      ...createAppCommands({ store, api, tabs, run: () => run("manual"), editor: getEditorHandle }),
      ...createEditorCommands(getEditorHandle),
      ...createThemeCommands(store, api),
      ...createViewCommands(store, api),
      ...createFileCommands(flows, api),
      ...createOutputCommands(store),
      {
        id: "view.commandPalette",
        run: () => {
          const state = store.getState();
          if (state.modal?.kind === "palette") {
            state.closeModal();
            return;
          }
          // Fix round 1 (m-5): store.focus is only updated by explicit focus-capture handlers (OutputPanel,
          // Monaco) and is never reset when focus moves elsewhere (toolbar, tab bar, side bar, blur to body),
          // so it can go stale. The live DOM focus (the same signal contextFromState uses for outputFocus) is
          // the source of truth; state.focus is only a fallback when nothing meaningful has focus.
          const active = document.activeElement;
          const context =
            active && active !== document.body
              ? active.closest(".output")
                ? "output"
                : "editor"
              : state.focus === "output"
                ? "output"
                : "editor";
          state.openModal({ kind: "palette", context });
        },
      },
      {
        id: "format.document",
        isEnabled: () => format !== null,
        run: async () => void (await format?.formatTab()),
      },
    );
    return created;
  }, [store, api, tabs, run, flows, format]);

  const bindings = useMemo(() => resolveKeybindings(DEFAULT_KEYBINDINGS, store.getState().keybindings), [store]);
  const resolver = useMemo(() => new KeybindingResolver(bindings), [bindings]);

  useEffect(() => {
    const stop = startAutoRun(store, () => run("auto"));
    cancelPendingAutoRun.current = stop.cancelPending;
    return () => {
      stop();
      cancelPendingAutoRun.current = () => {};
    };
  }, [store, run]);

  useEffect(
    () =>
      startThemeSync(store, {
        root: document.documentElement,
        media: typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : null,
      }),
    [store],
  );

  useEffect(() => startAppearanceSync(store, document.documentElement), [store]);

  useEffect(() => {
    const unsubscribers = [
      api.on("run.events", ({ tabId, runId, events }) => coalescer.push(tabId, runId, events)),
      // A state or diagnostics message applies after every event queued before it for that tab.
      api.on("run.state", ({ tabId, runId, state, activeHandles }) => {
        coalescer.flush(tabId);
        store.getState().receiveState(runId, state, activeHandles, tabId);
      }),
      api.on("run.diagnostics", ({ tabId, runId, diagnostics }) => {
        coalescer.flush(tabId);
        store.getState().receiveDiagnostics(runId, diagnostics, tabId);
      }),
      api.on("menu.command", ({ command, args }) => {
        registry.execute(command, args);
      }),
      api.on("settings.changed", ({ settings }) => store.getState().updateSettings(settings)),
      api.on("file.opened", (payload) => void flows.handleOpened(payload)),
      api.on("file.saved", (payload) => flows.handleSaved(payload)),
      api.on("file.saveCancelled", (payload) => flows.handleSaveCancelled(payload)),
      api.on("file.saveFailed", (payload) => flows.handleSaveFailed(payload)),
      api.on("file.saveAsConfirm", (payload) => void flows.handleSaveAsConfirm(payload)),
      // Spec §20 (FA-I3): a notice Main sends after startup, validated before it is shown.
      api.on("app.notice", (payload) => {
        const notice = appNoticeSchema.safeParse(payload);
        if (notice.success) store.getState().addNotice(notice.data);
      }),
    ];
    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
  }, [store, api, registry, flows, coalescer]);

  useEffect(() => {
    if (!e2e) return;
    const agent = createE2EAgent({
      store,
      editor: getEditorHandle,
      target: () => document.activeElement ?? document.body,
      executeCommand: (id, args) => registry.execute(id, args),
      missingEditorActions: () => getEditorHandle()?.missingActions(Object.values(EDITOR_ACTIONS)) ?? [],
      editorOptions: () => getEditorHandle()?.getOptions() ?? null,
      registeredCommands: () => registry.list().map((spec) => spec.id),
      regions: () => ({
        toolbar: document.querySelector(".toolbar") !== null,
        activityBar: document.querySelector(".activity-bar") !== null,
        sideBar: document.querySelector(".side-bar") !== null,
        statusBar: document.querySelector(".status-bar") !== null,
        output: document.querySelector(".output") !== null,
        tabBar: document.querySelector(".tab-bar") !== null,
        outputPlain: document.querySelector(".output-plain") !== null,
        lineAnchors: document.querySelector(".entry-line") !== null,
        staleLabel: document.querySelector(".output-stale-label") !== null,
      }),
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
            if (id === state.activeTabId) lastTypedAt.current = Date.now();
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

  const togglePanel = useCallback(
    (panel: "snippets" | "ai") => {
      const state = store.getState();
      const open = Boolean(state.settings?.view.sideBar);
      if (open && state.sideBarPanel === panel) {
        registry.execute("view.toggleSideBar");
        return;
      }
      state.setSideBarPanel(panel);
      if (!open) registry.execute("view.toggleSideBar");
    },
    [store, registry],
  );

  if (!tab || !settings) return null;
  const tabId = tab.id;
  const busy = runState !== null && BUSY_STATES.has(runState);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: file drops land anywhere in the window (spec §10.2); not a control
    <div
      className="app"
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files")) event.preventDefault();
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        const folders = new Set(
          [...event.dataTransfer.items]
            .filter((item) => item.webkitGetAsEntry?.()?.isDirectory)
            .map((item) => item.getAsFile()?.name ?? ""),
        );
        void flows.dropFiles([...event.dataTransfer.files], folders);
      }}
    >
      <Toolbar
        autoRun={settings.run.autoRun}
        busy={busy}
        onToggleAutoRun={() => registry.execute("run.toggleAutoRun")}
        onRun={() => registry.execute("run.start")}
        onStop={() => registry.execute("run.stop")}
      >
        {tabCount > 1 || settings.view.tabBarForSingleTab ? (
          <TabBar store={store} tabs={tabs} api={api} />
        ) : (
          <span className="toolbar-title">{deriveTitle(tab, store.getState().code)}</span>
        )}
      </Toolbar>
      {safeMode.active && <SafeModeBanner reason={safeMode.reason} />}
      <StartupNotices notices={notices} onDismiss={(id) => store.getState().dismissNotice(id)} />
      <div className="app-main">
        {settings.view.activityBar && (
          <ActivityBar
            busy={busy}
            sideBarOpen={settings.view.sideBar}
            panel={sideBarPanel}
            canOpenSettings={registry.isEnabled("app.settings")}
            onRun={() => registry.execute("run.start")}
            onStop={() => registry.execute("run.stop")}
            onPanel={togglePanel}
            onSettings={() => registry.execute("app.settings")}
          />
        )}
        {settings.view.sideBar && <SideBar panel={sideBarPanel} />}
        <SplitPane
          orientation={tab.layout.orientation}
          size={tab.layout.editorSize}
          secondVisible={tab.layout.outputVisible}
          onResize={(size) => store.getState().setEditorSize(size)}
          onReset={() => store.getState().resetEditorSize()}
          first={<Editor store={store} api={api} onLargePaste={flows.confirmLargePaste} />}
          second={<OutputPanel store={store} api={api} />}
        />
      </div>
      {settings.view.statusBar && (
        <StatusBar store={store} onToggleLayout={() => registry.execute("view.toggleLayout")} />
      )}
      <RenameDialog store={store} />
      <ConfirmDialog store={store} dialogs={dialogs} />
      <CommandPalette store={store} registry={registry} bindings={bindings} />
      {runState === "unresponsive" && (
        <UnresponsiveDialog onKill={() => registry.execute("run.kill")} onWait={() => api.wait(tabId)} />
      )}
    </div>
  );
}
