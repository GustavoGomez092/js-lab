import type { BootstrapPayload, DiagnosticPayload, RunEvent, RunState, StartupNotice } from "@jslab/rpc-schema";
import type { Language, Settings, TabState } from "@jslab/shared";
import { createStore } from "zustand/vanilla";
import { applyRunEvents, applyRunState, initialOutput, type OutputState } from "./output";

export interface AppState {
  ready: boolean;
  settings: Settings | null;
  safeMode: BootstrapPayload["safeMode"];
  versions: BootstrapPayload["versions"] | null;
  tab: TabState | null;
  code: string;
  /** Restored code never auto-runs until the user edits or presses Run (spec §5.14). */
  autoRunArmed: boolean;
  output: OutputState;
  diagnostics: DiagnosticPayload[];
  hoveredLine: number | null;
  revealRequest: { line: number; nonce: number } | null;
  notices: StartupNotice[];

  hydrate(payload: BootstrapPayload): void;
  editCode(code: string): void;
  armAutoRun(): void;
  setLanguage(language: Language): void;
  setEditorSize(size: number): void;
  toggleOrientation(): void;
  receiveEvents(runId: string, events: RunEvent[]): void;
  receiveState(runId: string, state: RunState, activeHandles?: number): void;
  receiveDiagnostics(runId: string, diagnostics: DiagnosticPayload[]): void;
  clearOutput(): void;
  setHoveredLine(line: number | null): void;
  reveal(line: number): void;
  dismissNotice(id: StartupNotice["id"]): void;
}

export function shouldAutoRun(state: Pick<AppState, "settings" | "safeMode" | "autoRunArmed">): boolean {
  return Boolean(state.settings?.run.autoRun) && !state.safeMode.active && state.autoRunArmed;
}

export function createAppStore() {
  return createStore<AppState>()((set, get) => ({
    ready: false,
    settings: null,
    safeMode: { active: false, reason: null },
    versions: null,
    tab: null,
    code: "",
    autoRunArmed: false,
    output: initialOutput,
    diagnostics: [],
    hoveredLine: null,
    revealRequest: null,
    notices: [],

    hydrate(payload) {
      const tab = payload.session.tabs[payload.session.activeTabId] ?? null;
      set({
        ready: true,
        settings: payload.settings,
        safeMode: payload.safeMode,
        versions: payload.versions,
        tab,
        code: tab ? (payload.buffers[tab.id] ?? "") : "",
        autoRunArmed: false,
        notices: payload.notices ?? [],
      });
    },

    editCode(code) {
      set({ code, autoRunArmed: true });
    },

    armAutoRun() {
      set({ autoRunArmed: true });
    },

    setLanguage(language) {
      const tab = get().tab;
      if (tab) set({ tab: { ...tab, language } });
    },

    setEditorSize(size) {
      const tab = get().tab;
      if (tab) set({ tab: { ...tab, layout: { ...tab.layout, editorSize: Math.min(90, Math.max(10, size)) } } });
    },

    toggleOrientation() {
      const tab = get().tab;
      if (!tab) return;
      const orientation = tab.layout.orientation === "horizontal" ? "vertical" : "horizontal";
      set({ tab: { ...tab, layout: { ...tab.layout, orientation } } });
    },

    receiveEvents(runId, events) {
      set({ output: applyRunEvents(get().output, runId, events) });
    },

    receiveState(runId, runState, activeHandles) {
      const previousRunId = get().output.runId;
      const output = applyRunState(get().output, runId, runState, activeHandles);
      set(output.runId !== previousRunId ? { output, diagnostics: [] } : { output });
    },

    receiveDiagnostics(runId, diagnostics) {
      if (runId === get().output.runId) set({ diagnostics });
    },

    clearOutput() {
      set({ output: { ...get().output, entries: [], stale: false, truncated: 0 } });
    },

    setHoveredLine(line) {
      set({ hoveredLine: line });
    },

    reveal(line) {
      set({ revealRequest: { line, nonce: (get().revealRequest?.nonce ?? 0) + 1 } });
    },

    dismissNotice(id) {
      set({ notices: get().notices.filter((notice) => notice.id !== id) });
    },
  }));
}

export type AppStore = ReturnType<typeof createAppStore>;
