import type { RunState } from "@jslab/rpc-schema";
import {
  deriveTitle,
  isDirty,
  type Language,
  type Runtime,
  type Settings,
  type TabLayout,
  tabLabel,
} from "@jslab/shared";
import { filterCounts } from "../output/filters";
import { entryToText } from "../output/text";
import { initialOutput, visibleEntries } from "../state/output";
import type { AppState } from "../state/store";

export interface TabSnapshot {
  id: string;
  title: string;
  label: string;
  workingDirectory: string | null;
  titleIsCustom: boolean;
  language: Language;
  runtime: Runtime;
  filePath: string | null;
  dirty: boolean;
  /** B1: true when `code` below is a placeholder rather than the tab's real contents. */
  unreadable: boolean;
  layout: TabLayout;
  code: string;
  runState: RunState | null;
  activeHandles: number;
  autoRunArmed: boolean;
  logpoints: number[];
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
  /** Which panel the side bar is showing, so a scenario can assert Show Transpiled Output switched it (spec §7.4). */
  sideBarPanel: AppState["sideBarPanel"];
  outputFilter: AppState["outputFilter"];
  outputCounts: Record<AppState["outputFilter"], number>;
  statusMessage: string | null;
  cursor: AppState["cursor"];
  notices: AppState["notices"];
  themeId: string;
  vimMode: string | null;
  fontFallback: boolean;
  /** Spec §13: how many snippets the library holds, so a scenario can watch an import or an export land. */
  snippetCount: number;
  npm: {
    installed: { name: string; version: string | null; latest: string | null }[];
    operations: { kind: string; target: string; status: string; errorKind: string | null; notice: string | null }[];
    outdatedError: string | null;
  };
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
        label: tabLabel(deriveTitle(tab, code), tab.workingDirectory),
        workingDirectory: tab.workingDirectory,
        titleIsCustom: tab.titleIsCustom,
        language: tab.language,
        runtime: tab.runtime,
        filePath: tab.filePath,
        // B1: a placeholder is never "modified" -- comparing it against the real file's hash is exactly what
        // made an unreadable tab look like an unsaved edit worth writing back.
        unreadable: state.unreadableBuffers.includes(id),
        dirty: !state.unreadableBuffers.includes(id) && isDirty(tab, code),
        layout: tab.layout,
        code,
        runState: output.runState,
        activeHandles: output.activeHandles,
        autoRunArmed: state.runtimes[id]?.autoRunArmed ?? false,
        logpoints: state.runtimes[id]?.logpoints ?? [],
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
    sideBarPanel: state.sideBarPanel,
    outputFilter: state.outputFilter,
    outputCounts: filterCounts(
      visibleEntries(state.output, { showUndefined: state.settings?.run.showUndefined ?? false }),
    ),
    statusMessage: state.statusMessage,
    cursor: state.cursor,
    notices: state.notices,
    themeId: state.themeId,
    vimMode: state.vimMode,
    fontFallback: state.fontFallback,
    snippetCount: state.snippets.length,
    npm: {
      installed: state.npm.installed.map(({ name, version, latest }) => ({ name, version, latest })),
      operations: state.npm.operations.map((op) => ({
        kind: op.kind,
        target: op.target,
        status: op.status,
        errorKind: op.error?.kind ?? null,
        notice: op.notice,
      })),
      outdatedError: state.npm.outdatedError?.kind ?? null,
    },
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
