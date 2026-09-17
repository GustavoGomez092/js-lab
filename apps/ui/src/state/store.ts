import type {
  BootstrapPayload,
  DiagnosticPayload,
  InstalledPackage,
  NpmListResult,
  NpmOpError,
  NpmOperation,
  RunEvent,
  RunState,
  StartupNotice,
} from "@jslab/rpc-schema";
import {
  type KeybindingRule,
  type Language,
  type Runtime,
  type Settings,
  type TabState,
  tabAfterClose,
} from "@jslab/shared";
import { createStore } from "zustand/vanilla";
import { MAX_NPM_LOG_CHARS, MAX_NPM_OPERATIONS, maskCredentials, splitLogChunk } from "../npm/npm-panel";
import type { TimerApi } from "./auto-run";
import { applyRunEvents, applyRunState, dismissWebDialog, initialOutput, type OutputState } from "./output";
import { clampEditorSize, EDITOR_SIZE_RESET, insertAfterActive, isPermutation, renamePatch } from "./workspace";

export interface TabRuntime {
  /**
   * Fix round 1 (I-1/M-2): `workingDirectoryMissing` is a store-local extension of `OutputState`, kept in lockstep
   * with `stale` by `withWorkingDirectoryMissing` below, instead of `StatusBar` scanning `entries` on every render.
   * `OutputState` itself (in `./output`, a separate reducer module) is unchanged.
   */
  output: OutputState & { workingDirectoryMissing: boolean };
  diagnostics: DiagnosticPayload[];
  /** Restored tabs never auto-run until edited or run manually (spec §5.14). */
  autoRunArmed: boolean;
  /**
   * Task 15 (spec §5.12, EX-35): true while this tab's runner reports an AudioContext running or a media element
   * playing -- pushed by `run.audio` (event-driven, never polled), independent of `output.runState`/activeHandles
   * so the per-tab speaker icon (TabBar.tsx) tracks audio specifically, not every kind of handle.
   */
  audioActive: boolean;
  /**
   * Task 1 (spec §6.3, §10.1): the tab's logpoint lines, ascending and unique. Deliberately per-tab UI state and
   * never part of `TabState`: spec §10.1 says logpoints are not persisted, so they live here with `output` and
   * `diagnostics` rather than anywhere `session.json` can see them.
   */
  logpoints: number[];
}

const freshOutput = (): TabRuntime["output"] => ({ ...initialOutput, workingDirectoryMissing: false });

export const newRuntime = (): TabRuntime => ({
  output: freshOutput(),
  diagnostics: [],
  autoRunArmed: false,
  audioActive: false,
  logpoints: [],
});

/**
 * Fix round 1 (I-1): true exactly when the most recent events carried a `WorkingDirectoryError`, reset to false the
 * moment leftover entries from a previous run are actually cleared — the same instant `stale` flips from true to
 * false, so a stale error row can never keep calling a folder the user has since fixed "not found".
 */
function withWorkingDirectoryMissing(
  previous: TabRuntime["output"],
  next: OutputState,
  events: readonly RunEvent[] = [],
): TabRuntime["output"] {
  const cleared = previous.stale && !next.stale;
  const reported = events.some((event) => event.kind === "error" && event.name === "WorkingDirectoryError");
  return { ...next, workingDirectoryMissing: reported || (cleared ? false : previous.workingDirectoryMissing) };
}

export type FocusArea = "editor" | "output" | "other";
export type OutputFilter = "all" | "results" | "logs" | "errors";
export type ConfirmButton = { id: string; label: string; role?: "primary" | "danger" | "cancel" };
export type Modal =
  | { kind: "palette"; context: "editor" | "output" }
  | { kind: "confirm"; id: string; title: string; message: string; buttons: ConfirmButton[] }
  | { kind: "rename"; tabId: string }
  | { kind: "npm" }
  | { kind: "env" };

export interface NpmUiState {
  /** False until the first list arrives, so the initial load highlights nothing. */
  loaded: boolean;
  installed: InstalledPackage[];
  outdatedCheckedAt: number | null;
  outdatedError: NpmOpError | null;
  operations: NpmOperation[];
  /**
   * R-M3-T26-LOGCAP-2 (parked R-M3-T18-LOGCAP-1): the live `npm.log` stream, kept per `opId` (never one merged
   * blob) so the drawer for one operation can't evict another's diagnostic output. Each buffer is masked
   * (M-6) before it is stored, capped at MAX_NPM_LOG_CHARS by trimming from the front, and deleted once its
   * operation is dismissed or ages out of `operations`.
   */
  logs: Record<string, string>;
  /**
   * Fix round 2 (I-1), line-based since fix round 3: the unmasked tail of each operation's log stream after its
   * last line break (see `splitLogChunk`), so a credential split across `npm.log` chunks is never stored, rendered
   * or copied in clear. Never read outside `appendNpmLog`/`receiveNpmOperation`; not in the E2E snapshot.
   */
  carries: Record<string, string>;
  /**
   * Fix round 2 (M-2): the unmasked spec behind each operation's (masked) `target`, so Retry can still resend
   * the real spec. Never rendered and never spread into the E2E snapshot (`snapshot.ts` maps `operations`
   * field by field).
   */
  rawTargets: Record<string, string>;
  lastAdded: { name: string; at: number } | null;
  /**
   * R-M3-OUTDATED-1: the highest `NpmListResult.revision` applied so far. The store is recreated with the window
   * and Main's own counter never resets while Main runs, so a fresh store starts below any real revision and
   * accepts the first result it sees, whichever channel (response or push) delivers it.
   */
  lastRevision: number;
}

export const initialNpm = (): NpmUiState => ({
  loaded: false,
  installed: [],
  outdatedCheckedAt: null,
  outdatedError: null,
  operations: [],
  logs: {},
  carries: {},
  rawTargets: {},
  lastAdded: null,
  lastRevision: -1,
});

/**
 * Fix round 2 (N-3): trims `operations` to `MAX_NPM_OPERATIONS`, evicting the oldest *finished* (succeeded or
 * failed) operations first, and only falling back to the oldest operation overall (queued or running included)
 * once every finished one is already gone.
 */
function evictOperations(operations: readonly NpmOperation[]): NpmOperation[] {
  if (operations.length <= MAX_NPM_OPERATIONS) return [...operations];
  let toRemove = operations.length - MAX_NPM_OPERATIONS;
  const removeAt = new Set<number>();
  for (let index = 0; index < operations.length && toRemove > 0; index += 1) {
    const op = operations[index];
    if (op && (op.status === "succeeded" || op.status === "failed")) {
      removeAt.add(index);
      toRemove -= 1;
    }
  }
  for (let index = 0; index < operations.length && toRemove > 0; index += 1) {
    if (removeAt.has(index)) continue;
    removeAt.add(index);
    toRemove -= 1;
  }
  return operations.filter((_, index) => !removeAt.has(index));
}

export interface AppState {
  ready: boolean;
  settings: Settings | null;
  /** Counts `settings.changed` broadcasts, so a response sent before the latest one is recognized as stale. */
  settingsRevision: number;
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
  statusSticky: boolean;
  cursor: { line: number; column: number } | null;
  vimMode: string | null;
  themeId: string;
  /** True when `appearance.font` failed to load and JetBrains Mono is in use instead (spec §9.4). */
  fontFallback: boolean;
  /** Which panel the side bar shows when open (Task 16). Snippets and AI Chat arrive in M5. */
  sideBarPanel: "snippets" | "ai";
  /** Bumped on every `npm.changed` message, so the editor's type feeder invalidates its package cache (Task 23). */
  packagesRevision: number;
  /** The NPM Packages sheet (spec §11.2, Task 26). */
  npm: NpmUiState;

  // Mirrors of the active tab, so M1 components keep reading a single tab.
  tab: TabState | null;
  code: string;
  autoRunArmed: boolean;
  output: TabRuntime["output"];
  diagnostics: DiagnosticPayload[];
  logpoints: number[];

  hoveredLine: number | null;
  revealRequest: { line: number; nonce: number } | null;
  /** Startup notices from Main (Task 9, spec §20). */
  notices: StartupNotice[];

  hydrate(payload: BootstrapPayload): void;
  dismissNotice(id: StartupNotice["id"]): void;
  /** A notice Main sends after startup (`app.notice`, FA-I3): shown once per id, at most MAX_NOTICES at a time. */
  addNotice(notice: StartupNotice): void;
  editCode(code: string, tabId?: string): void;
  armAutoRun(): void;
  setLanguage(language: Language): void;
  setRuntime(runtime: Runtime): void;
  setEditorSize(size: number): void;
  resetEditorSize(): void;
  toggleOrientation(): void;
  setOrientation(orientation: TabState["layout"]["orientation"]): void;
  toggleOutputVisible(): void;
  /** M4 Task 8: the nested split between the Console and Web View tiles (`layout.tiles.consoleSize`). */
  setConsoleSize(size: number): void;
  resetConsoleSize(): void;
  toggleWebviewVisible(): void;
  /** Task 15 (spec §5.12, EX-35): flips a specific tab's saved mute preference -- unlike `updateLayout`'s other
   * callers, this must be able to target a background tab (TabBar.tsx renders every tab's indicator, not just
   * the active one's). */
  toggleMuted(tabId: string): void;
  receiveEvents(runId: string, events: RunEvent[], tabId?: string): void;
  receiveState(runId: string, state: RunState, activeHandles?: number, tabId?: string): void;
  receiveDiagnostics(runId: string, diagnostics: DiagnosticPayload[], tabId?: string): void;
  /** Task 15 (spec §5.12, EX-35): applies a `run.audio` push. Always carries an explicit `tabId` (unlike the
   * other `receive*` methods, there is no M1-era "no active tab yet" caller to default for). */
  receiveAudio(active: boolean, tabId: string): void;
  clearOutput(tabId?: string): void;
  /** Spec §6.3: adds or removes a logpoint on `line` and arms Auto Run, so the change triggers a run. */
  toggleLogpoint(line: number, tabId?: string): void;
  /** Spec §6.3 (`Cmd+Shift+F9`): drops every logpoint on the tab and arms Auto Run. */
  clearLogpoints(tabId?: string): void;
  /**
   * Reconciliation from the editor's sticky decorations after an edit moved them (spec §6.3). Not a user action:
   * it never arms Auto Run, and an unchanged set keeps the previous array identity.
   */
  setLogpoints(lines: readonly number[], tabId?: string): void;
  /** Task 13: removes one shown alert() dialog from its tab's queue, once the user has answered it. Defaults to
   *  the active tab, like every other `tabId?`-optional action here. */
  dismissWebDialog(key: string, tabId?: string): void;
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
  /** A `settings.changed` broadcast from Main: applied, and it makes in-flight update responses stale (FB-m6). */
  receiveSettings(settings: Settings): void;
  setFocus(focus: FocusArea): void;
  openModal(modal: Modal): void;
  closeModal(): void;
  setOutputFilter(filter: OutputFilter): void;
  /**
   * Shows a status-bar message (FB-m5). A non-sticky message clears after STATUS_MESSAGE_MS, on the next edit, or when
   * a run starts; a sticky one (a busy indicator, a font fallback) stays until replaced or cleared.
   */
  setStatusMessage(message: string | null, options?: { sticky?: boolean }): void;
  /** Clears the status message unless it is sticky. */
  clearTransientStatus(): void;
  setCursor(cursor: { line: number; column: number } | null): void;
  setVimMode(mode: string | null): void;
  setThemeId(themeId: string): void;
  setFontFallback(value: boolean): void;
  setSideBarPanel(panel: "snippets" | "ai"): void;
  bumpPackagesRevision(): void;
  /** Spec §11.2. Bumps `packagesRevision` when the installed name@version set changes (not on `latest` alone). */
  receiveNpmList(list: NpmListResult, now?: number): void;
  /** Fix round 2 (M-2): stores `target` and `error.log` masked; the raw target goes to `npm.rawTargets` for Retry. */
  receiveNpmOperation(operation: NpmOperation): void;
  /** Fix round 3: complete lines are masked and stored; the text after the last line break is carried. */
  appendNpmLog(opId: string, text: string): void;
}

export function shouldAutoRun(state: Pick<AppState, "settings" | "safeMode" | "autoRunArmed">): boolean {
  return Boolean(state.settings?.run.autoRun) && !state.safeMode.active && state.autoRunArmed;
}

const NO_DIAGNOSTICS: DiagnosticPayload[] = [];

const NO_LOGPOINTS: number[] = [];

/** Most notices shown at once; the oldest is dropped first (FA-I3). */
export const MAX_NOTICES = 5;

/** How long a non-sticky status message stays (FB-m5). */
export const STATUS_MESSAGE_MS = 5000;

const defaultTimers: TimerApi = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function mirrorOf(state: Pick<AppState, "tabs" | "activeTabId" | "buffers" | "runtimes">) {
  const id = state.activeTabId;
  const runtime = id ? state.runtimes[id] : undefined;
  return {
    tab: id ? (state.tabs[id] ?? null) : null,
    code: id ? (state.buffers[id] ?? "") : "",
    autoRunArmed: runtime?.autoRunArmed ?? false,
    output: runtime?.output ?? freshOutput(),
    diagnostics: runtime?.diagnostics ?? NO_DIAGNOSTICS,
    logpoints: runtime?.logpoints ?? NO_LOGPOINTS,
  };
}

/** Ascending and unique; returns `previous` unchanged when the set is identical, so subscribers don't re-run. */
function normalizeLogpoints(previous: number[], lines: readonly number[]): number[] {
  const next = [...new Set(lines)].sort((a, b) => a - b);
  if (next.length === previous.length && next.every((line, index) => line === previous[index])) return previous;
  return next;
}

export function createAppStore(options: { timers?: TimerApi } = {}) {
  const timers = options.timers ?? defaultTimers;
  let statusTimer: unknown = null;
  const cancelStatusTimer = () => {
    if (statusTimer === null) return;
    timers.clearTimeout(statusTimer);
    statusTimer = null;
  };
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

    /**
     * Whether the caller named a tab that no longer exists.
     *
     * `resolve` answers `null` for two entirely different requests: "no tabId given, so act on the active tab"
     * and "this tabId names a tab that is gone". Any caller that writes the active-tab mirror (`get().output`)
     * on the `null` branch must tell them apart, because collapsing the two applies a dead tab's operation to
     * whichever tab is live -- a late `clearOutput` for a tab the user just closed would wipe the output they
     * are actually looking at, and a stale `dismissWebDialog` would clear a dialog the live tab still needs
     * answered. `updateTab` above never had this bug: it re-checks `get().tabs[id]` and bails.
     */
    const namesMissingTab = (tabId?: string | null): boolean =>
      tabId !== undefined && tabId !== null && resolve(tabId) === null;

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
      settingsRevision: 0,
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
      statusSticky: false,
      cursor: null,
      vimMode: null,
      themeId: "graphite",
      fontFallback: false,
      sideBarPanel: "snippets",
      packagesRevision: 0,
      npm: initialNpm(),
      tab: null,
      code: "",
      autoRunArmed: false,
      output: freshOutput(),
      diagnostics: NO_DIAGNOSTICS,
      logpoints: NO_LOGPOINTS,
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

      addNotice(notice) {
        const notices = get().notices;
        if (notices.some((existing) => existing.id === notice.id)) return;
        set({ notices: [...notices, notice].slice(-MAX_NOTICES) });
      },

      editCode(code, tabId) {
        const id = resolve(tabId);
        if (!id) {
          set({ code, autoRunArmed: true });
          return;
        }
        get().clearTransientStatus();
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
        // Unlike setLanguage, this arms auto-run itself (mirrors editCode) rather than relying on the tab already
        // being dirty: spec §5.2 states switching a tab's runtime triggers a run when Auto Run is on, unconditionally.
        const id = resolve();
        const tab = id ? get().tabs[id] : undefined;
        if (!id || !tab) return;
        commit({
          tabs: { ...get().tabs, [id]: { ...tab, runtime } },
          runtimes: { ...get().runtimes, [id]: { ...(get().runtimes[id] ?? newRuntime()), autoRunArmed: true } },
        });
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

      setConsoleSize(size) {
        updateLayout((layout) => ({ tiles: { ...layout.tiles, consoleSize: clampEditorSize(size) } }));
      },

      resetConsoleSize() {
        // Fix round 1 (F8): 55, matching tiles.consoleSize's own schema default (packages/shared/src/session.ts)
        // -- unlike EDITOR_SIZE_RESET (50), which resets editorSize to a value that disagrees with its own default
        // too; that pre-existing mismatch is unchanged here, not propagated to a second control.
        updateLayout((layout) => ({ tiles: { ...layout.tiles, consoleSize: 55 } }));
      },

      toggleWebviewVisible() {
        updateLayout((layout) => ({ tiles: { ...layout.tiles, webviewVisible: !layout.tiles.webviewVisible } }));
      },

      toggleMuted(tabId) {
        updateTab(tabId, (tab) => ({ ...tab, layout: { ...tab.layout, muted: !tab.layout.muted } }));
      },

      toggleOutputVisible() {
        updateLayout((layout) => ({ outputVisible: !layout.outputVisible }));
      },

      receiveEvents(runId, events, tabId) {
        const id = tabId ?? get().activeTabId;
        if (!id) {
          const previous = get().output;
          set({ output: withWorkingDirectoryMissing(previous, applyRunEvents(previous, runId, events), events) });
          return;
        }
        if (!get().tabs[id]) return;
        updateRuntime(id, (runtime) => ({
          ...runtime,
          output: withWorkingDirectoryMissing(runtime.output, applyRunEvents(runtime.output, runId, events), events),
        }));
      },

      receiveState(runId, runState, activeHandles, tabId) {
        const id = tabId ?? get().activeTabId;
        if (!id) {
          const previous = get().output;
          const previousRunId = previous.runId;
          const output = withWorkingDirectoryMissing(previous, applyRunState(previous, runId, runState, activeHandles));
          set(output.runId !== previousRunId ? { output, diagnostics: [] } : { output });
          return;
        }
        if (!get().tabs[id]) return;
        updateRuntime(id, (runtime) => {
          const output = withWorkingDirectoryMissing(
            runtime.output,
            applyRunState(runtime.output, runId, runState, activeHandles),
          );
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

      receiveAudio(active, tabId) {
        if (!get().tabs[tabId]) return;
        updateRuntime(tabId, (runtime) => ({ ...runtime, audioActive: active }));
      },

      clearOutput(tabId) {
        const clear = (output: TabRuntime["output"]): TabRuntime["output"] => ({
          ...output,
          entries: [],
          stale: false,
          truncated: 0,
          // Task 13: clearing the output clears any still-shown alert() dialog with it, the same as it already
          // does for a WorkingDirectoryError row (fix round 1, I-1).
          dialogs: [],
          workingDirectoryMissing: false,
        });
        // A tabId naming a tab that has since closed is not a request to clear the ACTIVE tab's output.
        if (namesMissingTab(tabId)) return;
        const id = resolve(tabId);
        if (!id) set({ output: clear(get().output) });
        else updateRuntime(id, (runtime) => ({ ...runtime, output: clear(runtime.output) }));
      },

      toggleLogpoint(line, tabId) {
        const id = resolve(tabId);
        if (!id || !Number.isInteger(line) || line < 1) return;
        updateRuntime(id, (runtime) => {
          const has = runtime.logpoints.includes(line);
          const lines = has
            ? runtime.logpoints.filter((candidate) => candidate !== line)
            : [...runtime.logpoints, line];
          return { ...runtime, logpoints: normalizeLogpoints(runtime.logpoints, lines), autoRunArmed: true };
        });
      },

      clearLogpoints(tabId) {
        const id = resolve(tabId);
        if (!id) return;
        updateRuntime(id, (runtime) =>
          runtime.logpoints.length === 0 ? runtime : { ...runtime, logpoints: [], autoRunArmed: true },
        );
      },

      setLogpoints(lines, tabId) {
        const id = resolve(tabId);
        if (!id) return;
        updateRuntime(id, (runtime) => {
          const logpoints = normalizeLogpoints(
            runtime.logpoints,
            lines.filter((line) => Number.isInteger(line) && line >= 1),
          );
          return logpoints === runtime.logpoints ? runtime : { ...runtime, logpoints };
        });
      },

      dismissWebDialog(key, tabId) {
        // Same guard as `clearOutput` above: dismissing a dead tab's dialog must not dismiss the live tab's.
        if (namesMissingTab(tabId)) return;
        const id = resolve(tabId);
        // `dismissWebDialog` (./output) is typed against the runtime-agnostic `OutputState`, so its result is
        // merged back onto the full `TabRuntime["output"]` here rather than replacing it outright -- the same
        // shape `clearOutput`'s own `clear` above preserves `workingDirectoryMissing` through.
        const apply = (output: TabRuntime["output"]): TabRuntime["output"] => ({
          ...output,
          dialogs: dismissWebDialog(output, key).dialogs,
        });
        if (!id) set({ output: apply(get().output) });
        else updateRuntime(id, (runtime) => ({ ...runtime, output: apply(runtime.output) }));
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
        const activeId = get().activeTabId;
        const previous = get().tabs[tab.id];
        updateTab(tab.id, (current) => ({ ...tab, viewState: current.viewState }));
        // Fix round 1 (I-1/M-2): the active tab's WD changed underneath its last run's output, which belongs to
        // the previous folder; mark it stale like any other stale output, using the existing stale mechanism, so a
        // leftover WorkingDirectoryError row can't keep calling the *new* folder "not found" until the next run.
        // A background tab's own update, or one where the WD didn't change (e.g. a file.saved), leaves it alone.
        if (tab.id === activeId && previous && previous.workingDirectory !== tab.workingDirectory) {
          updateRuntime(tab.id, (runtime) => ({ ...runtime, output: { ...runtime.output, stale: true } }));
        }
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

      receiveSettings(settings) {
        set({ settings, settingsRevision: get().settingsRevision + 1 });
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

      setStatusMessage(statusMessage, options) {
        cancelStatusTimer();
        const sticky = statusMessage !== null && options?.sticky === true;
        set({ statusMessage, statusSticky: sticky });
        if (statusMessage === null || sticky) return;
        statusTimer = timers.setTimeout(() => {
          statusTimer = null;
          if (get().statusMessage === statusMessage && !get().statusSticky) set({ statusMessage: null });
        }, STATUS_MESSAGE_MS);
      },

      clearTransientStatus() {
        if (get().statusMessage === null || get().statusSticky) return;
        cancelStatusTimer();
        set({ statusMessage: null });
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

      setFontFallback(fontFallback) {
        if (fontFallback !== get().fontFallback) set({ fontFallback });
      },

      setSideBarPanel(sideBarPanel) {
        set({ sideBarPanel });
      },

      bumpPackagesRevision() {
        set({ packagesRevision: get().packagesRevision + 1 });
      },

      receiveNpmList(list, now = Date.now()) {
        const previous = get().npm;
        // R-M3-OUTDATED-1: a result older than the last one applied is dropped. This is what makes delivery
        // order-independent — the sheet's own `npm.list` response and a `npm.changed` push race with no ordering
        // guarantee, and the higher revision must always win, whichever channel delivers it later.
        if (list.revision < previous.lastRevision) return;
        const key = (installed: InstalledPackage[]) => installed.map((pkg) => `${pkg.name}@${pkg.version}`).join("\n");
        const known = new Set(previous.installed.map((pkg) => pkg.name));
        // Spec §11.2: only a package that appears after the list was already loaded is "newly added".
        const added = previous.loaded ? list.installed.find((pkg) => !known.has(pkg.name)) : undefined;
        set({
          npm: {
            ...previous,
            loaded: true,
            installed: list.installed,
            outdatedCheckedAt: list.outdatedCheckedAt,
            outdatedError: list.outdatedError,
            lastAdded: added ? { name: added.name, at: now } : previous.lastAdded,
            lastRevision: list.revision,
          },
          ...(key(previous.installed) !== key(list.installed) ? { packagesRevision: get().packagesRevision + 1 } : {}),
        });
      },

      receiveNpmOperation(operation) {
        const previous = get().npm;
        // Fix round 2 (M-2): the running line, the failure card, the R26-6 status bar and the E2E snapshot all
        // read straight off `operations`, so masking once here (instead of at every render) also closes I-2's
        // per-render masking cost. Retry still needs the real spec, kept apart in `rawTargets`.
        const maskedOperation: NpmOperation = {
          ...operation,
          target: maskCredentials(operation.target),
          error: operation.error ? { ...operation.error, log: maskCredentials(operation.error.log) } : null,
        };
        const merged = [...previous.operations.filter((existing) => existing.id !== operation.id), maskedOperation];
        const kept = evictOperations(merged);
        // R-M3-T26-LOGCAP-2 / fix round 2 (N-3): an operation's log, carry and raw-target entries are freed the
        // moment it ages out of this bounded, finished-first-evicted list.
        const keptIds = new Set(kept.map((op) => op.id));
        const logs = Object.fromEntries(Object.entries(previous.logs).filter(([id]) => keptIds.has(id)));
        const carries = Object.fromEntries(Object.entries(previous.carries).filter(([id]) => keptIds.has(id)));
        const rawTargets = Object.fromEntries(
          Object.entries({ ...previous.rawTargets, [operation.id]: operation.target }).filter(([id]) =>
            keptIds.has(id),
          ),
        );
        // Fix round 2 (I-1): a terminal status flushes whatever's left in this op's carry, masked, even with no
        // trailing whitespace boundary — it can't wait for a chunk that will never arrive.
        if ((operation.status === "succeeded" || operation.status === "failed") && carries[operation.id]) {
          logs[operation.id] = ((logs[operation.id] ?? "") + maskCredentials(carries[operation.id] as string)).slice(
            -MAX_NPM_LOG_CHARS,
          );
          delete carries[operation.id];
        }
        set({ npm: { ...previous, operations: kept, logs, carries, rawTargets } });
      },

      appendNpmLog(opId, text) {
        const previous = get().npm;
        // Fix round 3: hold the text after the last line break in the carry, so a credential split across chunks
        // (or containing whitespace) is only ever masked as part of its complete line. Never stored unmasked.
        const { ready, carry } = splitLogChunk(previous.carries[opId] ?? "", text);
        const logs = ready
          ? {
              ...previous.logs,
              [opId]: ((previous.logs[opId] ?? "") + maskCredentials(ready)).slice(-MAX_NPM_LOG_CHARS),
            }
          : previous.logs;
        set({ npm: { ...previous, logs, carries: { ...previous.carries, [opId]: carry } } });
      },
    };
  });
}

export type AppStore = ReturnType<typeof createAppStore>;
