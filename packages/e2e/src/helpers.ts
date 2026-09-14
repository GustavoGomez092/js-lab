export interface TabSnapshot {
  id: string;
  title: string;
  language: string;
  runtime: string;
  code: string;
  runState: string | null;
  activeHandles: number;
  autoRunArmed: boolean;
  entryCount: number;
  stale: boolean;
  truncated: number;
  layout: { orientation: string; outputVisible: boolean; editorSize?: number; [key: string]: unknown };
  [key: string]: unknown;
}

export interface UiState {
  ready: boolean;
  safeMode: { active: boolean; reason: string | null };
  activeTabId: string | null;
  tabOrder: string[];
  tabs: TabSnapshot[];
  // biome-ignore lint/suspicious/noExplicitAny: scenarios read arbitrary settings paths
  settings: Record<string, any> | null;
  cursor?: { line: number; column: number } | null;
  [key: string]: unknown;
}

export interface E2EState {
  ui: UiState;
  main: Record<string, unknown>;
}

export interface OutputEntry {
  kind: string;
  level?: string;
  line?: number;
  text: string;
}

export function activeTab(state: E2EState): TabSnapshot {
  const tab = state.ui.tabs.find((candidate) => candidate.id === state.ui.activeTabId);
  if (!tab) throw new Error(`No active tab in snapshot (activeTabId ${state.ui.activeTabId})`);
  return tab;
}

/** The id of the one tab added since `before`, once it is also the active tab; otherwise null (review I4). */
export function newActiveTabId(before: readonly string[], state: E2EState): string | null {
  const ui = state.ui as UiState | null;
  if (!ui) return null;
  const added = ui.tabOrder.filter((id) => !before.includes(id));
  const [only] = added;
  return added.length === 1 && only !== undefined && ui.activeTabId === only ? only : null;
}
