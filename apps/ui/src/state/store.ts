import type { BootstrapPayload, DiagnosticPayload, RunEvent, RunState, StartupNotice } from "@jslab/rpc-schema";
import {
  type KeybindingRule,
  type Language,
  type Runtime,
  type Settings,
  type TabState,
  tabAfterClose,
} from "@jslab/shared";
import { createStore } from "zustand/vanilla";
import { applyRunEvents, applyRunState, initialOutput, type OutputState } from "./output";
import { clampEditorSize, EDITOR_SIZE_RESET, insertAfterActive, isPermutation, renamePatch } from "./workspace";

export interface TabRuntime {
  output: OutputState;
  diagnostics: DiagnosticPayload[];
  /** Restored tabs never auto-run until edited or run manually (spec §5.14). */
  autoRunArmed: boolean;
}

export const newRuntime = (): TabRuntime => ({ output: initialOutput, diagnostics: [], autoRunArmed: false });

export type FocusArea = "editor" | "output" | "other";
export type OutputFilter = "all" | "results" | "logs" | "errors";
export type ConfirmButton = { id: string; label: string; role?: "primary" | "danger" | "cancel" };
export type Modal =
  | { kind: "palette"; context: "editor" | "output" }
  | { kind: "confirm"; id: string; title: string; message: string; buttons: ConfirmButton[] }
  | { kind: "rename"; tabId: string };

export interface AppState {
  ready: boolean;
  settings: Settings | null;
  safeMode: BootstrapPayload["safeMode"];
  versions: BootstrapPayload["versions"] | null;
  e2e: boolean;
  keybindings: KeybindingRule[];

  tabs: Record<string, TabState>;
  tabOrder: string[];
  activeTabId: string | null;
  buffers: Record<string, string>;
  runtimes: Record<string, TabRuntime>;
  closedCount: number;

  focus: FocusArea;
  modal: Modal | null;
  outputFilter: OutputFilter;
  statusMessage: string | null;
  cursor: { line: number; column: number } | null;
  vimMode: string | null;
  themeId: string;

  // Mirrors of the active tab, so M1 components keep reading a single tab.
  tab: TabState | null;
  code: string;
  autoRunArmed: boolean;
  output: OutputState;
  diagnostics: DiagnosticPayload[];

  hoveredLine: number | null;
  revealRequest: { line: number; nonce: number } | null;
  /** Startup notices from Main (Task 9, spec §20). */
  notices: StartupNotice[];

  hydrate(payload: BootstrapPayload): void;
  dismissNotice(id: StartupNotice["id"]): void;
  editCode(code: string, tabId?: string): void;
  armAutoRun(): void;
  setLanguage(language: Language): void;
  setRuntime(runtime: Runtime): void;
  setEditorSize(size: number): void;
  resetEditorSize(): void;
  toggleOrientation(): void;
  setOrientation(orientation: TabState["layout"]["orientation"]): void;
  toggleOutputVisible(): void;
  receiveEvents(runId: string, events: RunEvent[], tabId?: string): void;
  receiveState(runId: string, state: RunState, activeHandles?: number, tabId?: string): void;
  receiveDiagnostics(runId: string, diagnostics: DiagnosticPayload[], tabId?: string): void;
  clearOutput(tabId?: string): void;
  setHoveredLine(line: number | null): void;
  reveal(line: number): void;

  openTab(tab: TabState, content: string, activate?: boolean): void;
  removeTab(tabId: string, nextActiveId?: string | null): void;
  activateTab(tabId: string): void;
  reorderTabs(order: string[]): void;
  renameTab(tabId: string, title: string): void;
  applyTabUpdate(tab: TabState): void;
  setViewState(tabId: string, viewState: unknown): void;
  setClosedCount(count: number): void;

  updateSettings(settings: Settings): void;
  setFocus(focus: FocusArea): void;
  openModal(modal: Modal): void;
  closeModal(): void;
  setOutputFilter(filter: OutputFilter): void;
  setStatusMessage(message: string | null): void;
  setCursor(cursor: { line: number; column: number } | null): void;
  setVimMode(mode: string | null): void;
  setThemeId(themeId: string): void;
}

export function shouldAutoRun(state: Pick<AppState, "settings" | "safeMode" | "autoRunArmed">): boolean {
  return Boolean(state.settings?.run.autoRun) && !state.safeMode.active && state.autoRunArmed;
}

const NO_DIAGNOSTICS: DiagnosticPayload[] = [];

function mirrorOf(state: Pick<AppState, "tabs" | "activeTabId" | "buffers" | "runtimes">) {
  const id = state.activeTabId;
  const runtime = id ? state.runtimes[id] : undefined;
  return {
    tab: id ? (state.tabs[id] ?? null) : null,
    code: id ? (state.buffers[id] ?? "") : "",
    autoRunArmed: runtime?.autoRunArmed ?? false,
    output: runtime?.output ?? initialOutput,
    diagnostics: runtime?.diagnostics ?? NO_DIAGNOSTICS,
  };
}

export function createAppStore() {
  return createStore<AppState>()((set, get) => {
    /** Applies a patch and recomputes the active-tab mirrors (unless there is no active tab: M1's legacy path). */
    const commit = (patch: Partial<AppState>) => {
      const previous = get();
      const merged = { ...previous, ...patch };
      // A hover from the tab being left must never highlight a line in the tab being shown (m-3).
      const switchedTabs = merged.activeTabId !== previous.activeTabId;
      set(
        merged.activeTabId ? { ...patch, ...mirrorOf(merged), ...(switchedTabs ? { hoveredLine: null } : {}) } : patch,
      );
    };

    const resolve = (tabId?: string | null) => {
      const id = tabId ?? get().activeTabId;
      return id && get().tabs[id] ? id : null;
    };

    const updateTab = (tabId: string | null | undefined, update: (tab: TabState) => TabState) => {
      const id = resolve(tabId);
      const tab = id ? get().tabs[id] : undefined;
      if (!id || !tab) return;
      commit({ tabs: { ...get().tabs, [id]: update(tab) } });
    };

    const updateRuntime = (id: string, update: (runtime: TabRuntime) => TabRuntime) => {
      commit({ runtimes: { ...get().runtimes, [id]: update(get().runtimes[id] ?? newRuntime()) } });
    };

    const updateLayout = (update: (layout: TabState["layout"]) => Partial<TabState["layout"]>) =>
      updateTab(null, (tab) => ({ ...tab, layout: { ...tab.layout, ...update(tab.layout) } }));

    return {
      ready: false,
      settings: null,
      safeMode: { active: false, reason: null },
      versions: null,
      e2e: false,
      keybindings: [],
      tabs: {},
      tabOrder: [],
      activeTabId: null,
      buffers: {},
      runtimes: {},
      closedCount: 0,
      focus: "editor",
      modal: null,
      outputFilter: "all",
      statusMessage: null,
      cursor: null,
      vimMode: null,
      themeId: "graphite",
      tab: null,
      code: "",
      autoRunArmed: false,
      output: initialOutput,
      diagnostics: NO_DIAGNOSTICS,
      hoveredLine: null,
      revealRequest: null,
      notices: [],

      hydrate(payload) {
        const { session } = payload;
        const activeTabId = session.tabs[session.activeTabId] ? session.activeTabId : (session.tabOrder[0] ?? null);
        commit({
          ready: true,
          settings: payload.settings,
          safeMode: payload.safeMode,
          versions: payload.versions,
          notices: payload.notices ?? [],
          e2e: payload.e2e === true,
          keybindings: payload.keybindings ?? [],
          tabs: session.tabs,
          tabOrder: session.tabOrder,
          activeTabId,
          buffers: Object.fromEntries(session.tabOrder.map((id) => [id, payload.buffers[id] ?? ""])),
          runtimes: Object.fromEntries(session.tabOrder.map((id) => [id, newRuntime()])),
          closedCount: session.closedStack.length,
        });
      },

      dismissNotice(id) {
        set({ notices: get().notices.filter((notice) => notice.id !== id) });
      },

      editCode(code, tabId) {
        const id = resolve(tabId);
        if (!id) {
          set({ code, autoRunArmed: true });
          return;
        }
        commit({
          buffers: { ...get().buffers, [id]: code },
          runtimes: { ...get().runtimes, [id]: { ...(get().runtimes[id] ?? newRuntime()), autoRunArmed: true } },
        });
      },

      armAutoRun() {
        const id = resolve();
        if (!id) set({ autoRunArmed: true });
        else updateRuntime(id, (runtime) => ({ ...runtime, autoRunArmed: true }));
      },

      setLanguage(language) {
        updateTab(null, (tab) => ({ ...tab, language }));
      },

      setRuntime(runtime) {
        updateTab(null, (tab) => ({ ...tab, runtime }));
      },

      setEditorSize(size) {
        updateLayout(() => ({ editorSize: clampEditorSize(size) }));
      },

      resetEditorSize() {
        updateLayout(() => ({ editorSize: EDITOR_SIZE_RESET }));
      },

      toggleOrientation() {
        updateLayout((layout) => ({ orientation: layout.orientation === "horizontal" ? "vertical" : "horizontal" }));
      },

      setOrientation(orientation) {
        updateLayout(() => ({ orientation }));
      },

      toggleOutputVisible() {
        updateLayout((layout) => ({ outputVisible: !layout.outputVisible }));
      },

      receiveEvents(runId, events, tabId) {
        const id = tabId ?? get().activeTabId;
        if (!id) {
          set({ output: applyRunEvents(get().output, runId, events) });
          return;
        }
        if (!get().tabs[id]) return;
        updateRuntime(id, (runtime) => ({ ...runtime, output: applyRunEvents(runtime.output, runId, events) }));
      },

      receiveState(runId, runState, activeHandles, tabId) {
        const id = tabId ?? get().activeTabId;
        if (!id) {
          const previousRunId = get().output.runId;
          const output = applyRunState(get().output, runId, runState, activeHandles);
          set(output.runId !== previousRunId ? { output, diagnostics: [] } : { output });
          return;
        }
        if (!get().tabs[id]) return;
        updateRuntime(id, (runtime) => {
          const output = applyRunState(runtime.output, runId, runState, activeHandles);
          return output.runId !== runtime.output.runId
            ? { ...runtime, output, diagnostics: [] }
            : { ...runtime, output };
        });
      },

      receiveDiagnostics(runId, diagnostics, tabId) {
        const id = tabId ?? get().activeTabId;
        if (!id) {
          if (runId === get().output.runId) set({ diagnostics });
          return;
        }
        const runtime = get().runtimes[id];
        if (runtime && runId === runtime.output.runId) updateRuntime(id, (current) => ({ ...current, diagnostics }));
      },

      clearOutput(tabId) {
        const clear = (output: OutputState): OutputState => ({ ...output, entries: [], stale: false, truncated: 0 });
        const id = resolve(tabId);
        if (!id) set({ output: clear(get().output) });
        else updateRuntime(id, (runtime) => ({ ...runtime, output: clear(runtime.output) }));
      },

      setHoveredLine(line) {
        set({ hoveredLine: line });
      },

      reveal(line) {
        set({ revealRequest: { line, nonce: (get().revealRequest?.nonce ?? 0) + 1 } });
      },

      openTab(tab, content, activate = true) {
        if (get().tabs[tab.id]) {
          if (activate) commit({ activeTabId: tab.id });
          return;
        }
        commit({
          tabs: { ...get().tabs, [tab.id]: tab },
          tabOrder: insertAfterActive(get().tabOrder, get().activeTabId, tab.id),
          buffers: { ...get().buffers, [tab.id]: content },
          runtimes: { ...get().runtimes, [tab.id]: newRuntime() },
          activeTabId: activate || !get().activeTabId ? tab.id : get().activeTabId,
        });
      },

      removeTab(tabId, nextActiveId) {
        if (!get().tabs[tabId]) return;
        const { [tabId]: _tab, ...tabs } = get().tabs;
        const { [tabId]: _buffer, ...buffers } = get().buffers;
        const { [tabId]: _runtime, ...runtimes } = get().runtimes;
        const current = get().activeTabId;
        const fallback = current ? tabAfterClose(get().tabOrder, tabId, current) : null;
        const activeTabId = nextActiveId && tabs[nextActiveId] ? nextActiveId : fallback;
        const patch = { tabs, buffers, runtimes, tabOrder: get().tabOrder.filter((id) => id !== tabId), activeTabId };
        if (activeTabId) commit(patch);
        else set({ ...patch, ...mirrorOf(patch), hoveredLine: null });
      },

      activateTab(tabId) {
        if (!get().tabs[tabId] || get().activeTabId === tabId) return;
        // commit() clears hoveredLine itself whenever activeTabId changes (m-3).
        commit({ activeTabId: tabId });
      },

      reorderTabs(order) {
        if (isPermutation(get().tabOrder, order)) commit({ tabOrder: [...order] });
      },

      renameTab(tabId, title) {
        updateTab(tabId, (tab) => ({ ...tab, ...renamePatch(title) }));
      },

      applyTabUpdate(tab) {
        updateTab(tab.id, (current) => ({ ...tab, viewState: current.viewState }));
      },

      setViewState(tabId, viewState) {
        updateTab(tabId, (tab) => ({ ...tab, viewState: viewState ?? null }));
      },

      setClosedCount(count) {
        set({ closedCount: Math.max(0, count) });
      },

      updateSettings(settings) {
        set({ settings });
      },

      setFocus(focus) {
        set({ focus });
      },

      openModal(modal) {
        set({ modal });
      },

      closeModal() {
        set({ modal: null });
      },

      setOutputFilter(outputFilter) {
        set({ outputFilter });
      },

      setStatusMessage(statusMessage) {
        set({ statusMessage });
      },

      setCursor(cursor) {
        set({ cursor });
      },

      setVimMode(vimMode) {
        set({ vimMode });
      },

      setThemeId(themeId) {
        if (themeId !== get().themeId) set({ themeId });
      },
    };
  });
}

export type AppStore = ReturnType<typeof createAppStore>;
