import { appNoticeSchema, MAX_TEXT_CHARS } from "@jslab/rpc-schema";
import {
  commandMeta,
  DEFAULT_KEYBINDINGS,
  formatChord,
  resolveKeybindings,
  shortcutFor,
  tabLabel,
} from "@jslab/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { EnvVarsSheet } from "../env/EnvVarsSheet";
import { createFileCommands } from "../files/file-commands";
import { createFileFlows } from "../files/file-flows";
import { createFormatActions } from "../format/format-actions";
import { type Formatter, shouldFormatBeforeRun } from "../format/formatter";
import { contextFromState, KeybindingResolver } from "../keybindings/resolver";
import { NpmSheet } from "../npm/NpmSheet";
import { operationStatusMessage } from "../npm/npm-panel";
import { OutputTiles } from "../output/OutputTiles";
import { WebViewHosts, type WebviewDock } from "../output/WebViewHosts";
import { CommandPalette } from "../palette/CommandPalette";
import { startAutoRun } from "../state/auto-run";
import { createBufferSync } from "../state/buffer-sync";
import { createEventCoalescer, createFrameScheduler } from "../state/event-coalescer";
import type { AppStore } from "../state/store";
import { strings } from "../strings";
import { RenameDialog } from "../tabs/RenameDialog";
import { TabBar } from "../tabs/TabBar";
import { createTabActions } from "../tabs/tab-actions";
import { createTabSummaryCache } from "../tabs/tab-summary";
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
import { computeTabPatch } from "./tab-patch";

const UI_HEARTBEAT_MS = 2000;

/**
 * Applies coalesced run events once per animation frame, or after FLUSH_TIMEOUT_MS when the hidden window gets no
 * frames (FB-I1). Tests pass a synchronous scheduler.
 */
const defaultScheduleFrame = createFrameScheduler({
  requestFrame: (callback) => void requestAnimationFrame(() => callback()),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
});

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
  // FB-I2: primitives only. `s.tab` is replaced by every view-state commit (cursor or scroll), and selecting it
  // re-rendered the whole shell about every 500 ms while the cursor moved.
  const tabId = useStore(store, (s) => s.tab?.id ?? null);
  const orientation = useStore(store, (s) => s.tab?.layout.orientation ?? "horizontal");
  const editorSize = useStore(store, (s) => s.tab?.layout.editorSize ?? 50);
  const outputVisible = useStore(store, (s) => s.tab?.layout.outputVisible ?? true);
  // FB-m9: the single-tab toolbar title follows edits; the summary cache keeps this selector cheap per keystroke.
  const [titles] = useState(createTabSummaryCache);
  const toolbarTitle = useStore(store, (s) =>
    s.tab ? tabLabel(titles.title(s.tab, s.code), s.tab.workingDirectory) : "",
  );
  // RR2-m1: this cache only ever needs the active tab's entry, so prune it to that one tab whenever it changes.
  // Otherwise every tab that was ever active, and its last buffer string, stays reachable for the window's life.
  useEffect(() => {
    titles.retain(new Set(tabId ? [tabId] : []));
  }, [titles, tabId]);
  const runState = useStore(store, (s) => s.output.runState);
  const safeMode = useStore(store, (s) => s.safeMode);
  const notices = useStore(store, (s) => s.notices);
  const settings = useStore(store, (s) => s.settings);
  const sideBarPanel = useStore(store, (s) => s.sideBarPanel);
  const tabCount = useStore(store, (s) => s.tabOrder.length);
  const npmOpen = useStore(store, (s) => s.modal?.kind === "npm");
  // Fix round 1 (F1/F2): lifted here, not into OutputTiles, specifically so it survives OutputTiles unmounting
  // (hiding the Output panel) -- see WebViewHosts.tsx's doc comment for the full mechanism.
  const [webviewDock, setWebviewDock] = useState<WebviewDock | null>(null);

  const lastTypedAt = useRef(0);
  // T16-rr1: the React-owned slot the Editor puts the Vim status node into, always rendered before the status bar.
  const vimSlot = useRef<HTMLDivElement>(null);
  // I-1: startAutoRun's cancelPending, kept current by the effect below. A format's own edit (applied
  // through Monaco) can arm a pending auto-run for the very code the run we're about to start already
  // covers; start() cancels it once the format has settled, before that timer can fire a duplicate run.
  const cancelPendingAutoRun = useRef<() => void>(() => {});
  const format = useMemo(
    () => (formatter ? createFormatActions({ store, formatter, editor: getEditorHandle }) : null),
    [store, formatter],
  );

  // X5: edits reach Main at most once per BUFFER_SYNC_DELAY_MS per tab; pending content is flushed on demand.
  const bufferSync = useMemo(() => createBufferSync((tabId, content) => api.bufferChanged(tabId, content)), [api]);
  useEffect(() => {
    const flushAll = () => bufferSync.flush();
    window.addEventListener("beforeunload", flushAll);
    // M-2: WebKit fires pagehide more reliably than beforeunload when the view goes away.
    window.addEventListener("pagehide", flushAll);
    return () => {
      window.removeEventListener("beforeunload", flushAll);
      window.removeEventListener("pagehide", flushAll);
      bufferSync.flush();
      bufferSync.dispose();
    };
  }, [bufferSync]);

  const run = useCallback(
    (reason: "auto" | "manual") => {
      const state = store.getState();
      if (!state.tab) return;
      // I-2: capture the tab this run is for. A format can take a noticeable time (worker cold start), and
      // the user can switch tabs while it runs; start() must still act on this tab, not whatever is active
      // once the format settles.
      const tabId = state.tab.id;
      // FB-m5: a run clears a transient status message first, so a format-on-run failure below still shows.
      state.clearTransientStatus();
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
        bufferSync.flush(tabId);
        void api.startRun({
          tabId,
          code,
          language: freshTab.language,
          logpoints: [],
          reason,
          runtime: freshTab.runtime,
        });
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
    [store, api, format, bufferSync],
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
  // RR2-m6: dispose whenever the coalescer is rebuilt or App unmounts, so a callback the scheduler already armed
  // can't apply queued events after this coalescer no longer owns them.
  useEffect(() => coalescer.dispose, [coalescer]);
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
    tabs.setBeforeClose(async (tabId) => {
      const allowed = await flows.beforeClose(tabId);
      // Main moves the buffer file into buffers/closed/ on close, so it must have the latest content first.
      if (allowed) bufferSync.flush(tabId);
      return allowed;
    });
    return () => tabs.setBeforeClose(null);
  }, [tabs, flows, bufferSync]);

  const bindings = useMemo(() => resolveKeybindings(DEFAULT_KEYBINDINGS, store.getState().keybindings), [store]);
  // R23-1: hoisted above the registry so app-commands' npm.install status message can show its keycap too.
  const keysFor = useCallback(
    (command: string) => {
      const chord = shortcutFor(bindings, command);
      return chord ? formatChord(chord) : null;
    },
    [bindings],
  );

  const registry = useMemo(() => {
    const created = new CommandRegistry((id, error) =>
      store.getState().setStatusMessage(strings.commands.failed(commandMeta(id)?.title ?? id, error)),
    );
    created.register(
      ...createAppCommands({ store, api, tabs, run: () => run("manual"), editor: getEditorHandle, keysFor }),
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
  }, [store, api, tabs, run, flows, format, keysFor]);

  const resolver = useMemo(() => new KeybindingResolver(bindings), [bindings]);
  // FB-m3: chrome keycaps follow the effective bindings, as the palette and the menu do.
  const keycaps = useMemo(
    () => ({
      run: keysFor("run.start"),
      stop: keysFor("run.stop"),
      settings: keysFor("app.settings"),
      npm: keysFor("tools.npmPackages"),
    }),
    [keysFor],
  );

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
      // Task 15 (spec §5.12, EX-35): no coalescer flush needed -- audio activity is its own independent signal,
      // not ordered against a tab's console/result events the way state/diagnostics are.
      api.on("run.audio", ({ tabId, active }) => store.getState().receiveAudio(active, tabId)),
      api.on("menu.command", ({ command, args }) => {
        registry.execute(command, args);
      }),
      api.on("settings.changed", ({ settings }) => store.getState().receiveSettings(settings)),
      // Task 26: Main's npm list changed; receiveNpmList bumps packagesRevision itself when names/versions change,
      // so the type feeder's package cache still invalidates without a separate, redundant bump here.
      api.on("npm.changed", (list) => store.getState().receiveNpmList(list)),
      api.on("npm.op", (operation) => {
        store.getState().receiveNpmOperation(operation);
        // R26-6: a finished operation still reports itself in the status bar when its sheet isn't open to show it.
        if (store.getState().modal?.kind !== "npm") {
          const message = operationStatusMessage(operation, keycaps.run);
          if (message) store.getState().setStatusMessage(message);
        }
      }),
      api.on("npm.log", ({ opId, text }) => store.getState().appendNpmLog(opId, text)),
      // Task 24: the working directory changed (wd.pick/wd.clear); the editor's own subscription invalidates
      // the type feeder for the active tab once the store's tab is updated (Editor.tsx, unchanged here).
      api.on("wd.changed", ({ tab }) => store.getState().applyTabUpdate(tab)),
      // Spec §16.3: a tab Main changed on its own -- `jslab --title` on an already-open file. The same store action
      // `wd.changed` above and `file.saved` below use; without it the UI never learns the rename (M5c F3).
      api.on("tab.updated", ({ tab }) => store.getState().applyTabUpdate(tab)),
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
      // X1: Main is quitting. Flush view state and edits, then acknowledge so Main can write the session.
      api.on("app.flushState", () => {
        getEditorHandle()?.flushViewState();
        bufferSync.flush();
        api.stateFlushed();
      }),
    ];
    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
  }, [store, api, registry, flows, coalescer, bufferSync, keycaps]);

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
      tsDiagnostics: () => getEditorHandle()?.typeDiagnostics() ?? Promise.resolve([]),
      completions: (offset) => getEditorHandle()?.completionsAt(offset) ?? Promise.resolve([]),
      installActions: () => getEditorHandle()?.installActions() ?? Promise.resolve([]),
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
        // M4 Task 16: the Web View tile's docking placeholder, which `OutputTiles` renders only for a runtime that
        // can host a webview and only while that tab's own Web View toggle is on -- so this is what an E2E
        // scenario reads to tell "the tile is on screen" from "a bun tab never gets one" (spec §7.1, parity WV-01).
        webViewTile: document.querySelector(".webview-tile-dock") !== null,
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
            else bufferSync.changed(id, content);
            if (id === state.activeTabId) lastTypedAt.current = Date.now();
          }
          const patch = computeTabPatch(before, next);
          if (patch) api.patchTab(id, patch);
        }
      }),
    [store, api, bufferSync],
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

  // R23-1: every install action (the editor's quick fix and the output row's button) dispatches npm.install, so the
  // status bar confirms it started.
  const install = useCallback((spec: string) => registry.execute("npm.install", { spec }), [registry]);

  if (!tabId || !settings) return null;
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
        runKeys={keycaps.run}
        stopKeys={keycaps.stop}
        onToggleAutoRun={() => registry.execute("run.toggleAutoRun")}
        onRun={() => registry.execute("run.start")}
        onStop={() => registry.execute("run.stop")}
      >
        {tabCount > 1 || settings.view.tabBarForSingleTab ? (
          <TabBar store={store} tabs={tabs} api={api} />
        ) : (
          <span className="toolbar-title">{toolbarTitle}</span>
        )}
      </Toolbar>
      {safeMode.active && <SafeModeBanner reason={safeMode.reason} />}
      <StartupNotices
        notices={notices}
        onDismiss={(id) => store.getState().dismissNotice(id)}
        // Spec §20: an unexpected Main error after startup offers Copy Debug Log in its banner.
        actions={{
          unexpectedError: { label: strings.notices.copyDebugLog, run: () => api.appCommand("copyDebugLog") },
        }}
      />
      <div className="app-main">
        {settings.view.activityBar && (
          <ActivityBar
            busy={busy}
            sideBarOpen={settings.view.sideBar}
            panel={sideBarPanel}
            canOpenSettings={registry.isEnabled("app.settings")}
            runKeys={keycaps.run}
            stopKeys={keycaps.stop}
            settingsKeys={keycaps.settings}
            npmOpen={npmOpen}
            npmKeys={keycaps.npm}
            onRun={() => registry.execute("run.start")}
            onStop={() => registry.execute("run.stop")}
            onPanel={togglePanel}
            onSettings={() => registry.execute("app.settings")}
            onNpm={() => registry.execute("tools.npmPackages")}
          />
        )}
        {settings.view.sideBar && <SideBar panel={sideBarPanel} />}
        <SplitPane
          orientation={orientation}
          size={editorSize}
          secondVisible={outputVisible}
          onResize={(size) => store.getState().setEditorSize(size)}
          onReset={() => store.getState().resetEditorSize()}
          first={
            <Editor
              store={store}
              api={api}
              onLargePaste={flows.confirmLargePaste}
              onInstall={install}
              vimSlot={vimSlot}
            />
          }
          second={
            <OutputTiles
              store={store}
              api={api}
              runKeys={keycaps.run}
              onInstall={install}
              onWebviewDock={setWebviewDock}
            />
          }
        />
      </div>
      {/* Fix round 1 (F1/F2): a sibling of the SplitPane above, not inside it -- so hiding the Output panel
          (which unmounts that SplitPane's `second`, OutputTiles included) never touches this. */}
      <WebViewHosts store={store} dock={webviewDock} api={api} />
      <div className="vim-slot" ref={vimSlot} />
      {settings.view.statusBar && (
        <StatusBar
          store={store}
          onToggleLayout={() => registry.execute("view.toggleLayout")}
          onToggleWebView={() => registry.execute("view.toggleWebView")}
          runKeys={keycaps.run}
          onPickWorkingDirectory={() => registry.execute("wd.set")}
          onClearWorkingDirectory={() => registry.execute("wd.clear")}
        />
      )}
      <RenameDialog store={store} />
      <ConfirmDialog store={store} dialogs={dialogs} />
      <EnvVarsSheet store={store} api={api} />
      <NpmSheet store={store} api={api} />
      <CommandPalette store={store} registry={registry} bindings={bindings} />
      {runState === "unresponsive" && (
        <UnresponsiveDialog onKill={() => registry.execute("run.kill")} onWait={() => api.wait(tabId)} />
      )}
    </div>
  );
}
