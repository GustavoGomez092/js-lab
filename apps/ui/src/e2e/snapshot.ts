import type { RunState } from "@jslab/rpc-schema";
import type { Language, Runtime, Settings } from "@jslab/shared";
import { entryToText } from "../output/text";
import { visibleEntries } from "../state/output";
import type { AppState } from "../state/store";

export interface TabSnapshot {
  id: string;
  title: string;
  language: Language;
  runtime: Runtime;
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
  settings: Settings | null;
  diagnostics: number;
  notices: AppState["notices"];
}

export interface OutputSnapshotEntry {
  kind: string;
  level?: string;
  line?: number;
  text: string;
}

/** JSON-safe view of the UI store for `e2e.state`. Task 11 widens it to every open tab. */
export function snapshotState(state: AppState): UiSnapshot {
  const tab = state.tab;
  return {
    ready: state.ready,
    safeMode: state.safeMode,
    activeTabId: tab?.id ?? null,
    tabOrder: tab ? [tab.id] : [],
    tabs: tab
      ? [
          {
            id: tab.id,
            title: tab.title,
            language: tab.language,
            runtime: tab.runtime,
            code: state.code,
            runState: state.output.runState,
            activeHandles: state.output.activeHandles,
            autoRunArmed: state.autoRunArmed,
            entryCount: state.output.entries.length,
            stale: state.output.stale,
            truncated: state.output.truncated,
          },
        ]
      : [],
    settings: state.settings,
    diagnostics: state.diagnostics.length,
    notices: state.notices,
  };
}

export function snapshotOutput(state: AppState): OutputSnapshotEntry[] {
  const showUndefined = state.settings?.run.showUndefined ?? false;
  return visibleEntries(state.output, { showUndefined }).map(({ event }) => {
    const line = event.kind === "result" || event.kind === "console" || event.kind === "error" ? event.line : undefined;
    return {
      kind: event.kind,
      ...(event.kind === "console" ? { level: event.level } : {}),
      ...(line !== undefined ? { line } : {}),
      text: entryToText(event),
    };
  });
}
