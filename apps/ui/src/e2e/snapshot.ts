import type { RunState } from "@jslab/rpc-schema";
import { deriveTitle, isDirty, type Language, type Runtime, type Settings, type TabLayout } from "@jslab/shared";
import { entryToText } from "../output/text";
import { initialOutput, visibleEntries } from "../state/output";
import type { AppState } from "../state/store";

export interface TabSnapshot {
  id: string;
  title: string;
  titleIsCustom: boolean;
  language: Language;
  runtime: Runtime;
  filePath: string | null;
  dirty: boolean;
  layout: TabLayout;
  code: string;
  runState: RunState | null;
  activeHandles: number;
  autoRunArmed: boolean;
  entryCount: number;
  stale: boolean;
  truncated: number;
}

export interface UiSnapshot {
  ready: boolean;
  safeMode: AppState["safeMode"];
  activeTabId: string | null;
  tabOrder: string[];
  tabs: TabSnapshot[];
  closedCount: number;
  settings: Settings | null;
  diagnostics: number;
  focus: AppState["focus"];
  modal: string | null;
  outputFilter: AppState["outputFilter"];
  statusMessage: string | null;
  cursor: AppState["cursor"];
  notices: AppState["notices"];
  themeId: string;
  vimMode: string | null;
  fontFallback: boolean;
}

export interface OutputSnapshotEntry {
  kind: string;
  level?: string;
  line?: number;
  text: string;
}

/** JSON-safe view of the UI store for `e2e.state` (spec §22.3). */
export function snapshotState(state: AppState): UiSnapshot {
  const tabs = state.tabOrder.flatMap((id): TabSnapshot[] => {
    const tab = state.tabs[id];
    if (!tab) return [];
    const code = state.buffers[id] ?? "";
    const output = state.runtimes[id]?.output ?? initialOutput;
    return [
      {
        id,
        title: deriveTitle(tab, code),
        titleIsCustom: tab.titleIsCustom,
        language: tab.language,
        runtime: tab.runtime,
        filePath: tab.filePath,
        dirty: isDirty(tab, code),
        layout: tab.layout,
        code,
        runState: output.runState,
        activeHandles: output.activeHandles,
        autoRunArmed: state.runtimes[id]?.autoRunArmed ?? false,
        entryCount: output.entries.length,
        stale: output.stale,
        truncated: output.truncated,
      },
    ];
  });
  return {
    ready: state.ready,
    safeMode: state.safeMode,
    activeTabId: state.activeTabId,
    tabOrder: state.tabOrder,
    tabs,
    closedCount: state.closedCount,
    settings: state.settings,
    diagnostics: state.diagnostics.length,
    focus: state.focus,
    modal: state.modal?.kind ?? null,
    outputFilter: state.outputFilter,
    statusMessage: state.statusMessage,
    cursor: state.cursor,
    notices: state.notices,
    themeId: state.themeId,
    vimMode: state.vimMode,
    fontFallback: state.fontFallback,
  };
}

export function snapshotOutput(state: AppState, tabId?: string): OutputSnapshotEntry[] {
  const id = tabId ?? state.activeTabId;
  const output = id ? (state.runtimes[id]?.output ?? initialOutput) : state.output;
  const showUndefined = state.settings?.run.showUndefined ?? false;
  return visibleEntries(output, { showUndefined }).map(({ event }) => {
    const line = event.kind === "result" || event.kind === "console" || event.kind === "error" ? event.line : undefined;
    return {
      kind: event.kind,
      ...(event.kind === "console" ? { level: event.level } : {}),
      ...(line !== undefined ? { line } : {}),
      text: entryToText(event),
    };
  });
}
