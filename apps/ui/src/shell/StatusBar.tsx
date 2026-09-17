import { baseName, isRuntimeAvailable, LANGUAGES, type Language, RUNTIMES, type Runtime } from "@jslab/shared";
import { useStore } from "zustand";
import type { AppStore } from "../state/store";
import { strings } from "../strings";
import { LANGUAGE_LABELS, RUNTIME_LABELS, runStateKind, runStateLabel } from "./labels";

export function StatusBar({
  store,
  onToggleLayout,
  onToggleWebView,
  runKeys,
  onPickWorkingDirectory,
  onClearWorkingDirectory,
}: {
  store: AppStore;
  onToggleLayout(): void;
  /** Dispatches `view.toggleWebView`, the one path the palette, the menu and the chord also take. */
  onToggleWebView(): void;
  /** The formatted Run chord from the effective bindings, or null when that binding was removed. */
  runKeys: string | null;
  onPickWorkingDirectory?(): void;
  onClearWorkingDirectory?(): void;
}) {
  // As built (M1 T18 fix round): primitive selectors only. `s.output` is a new object on every run.events batch,
  // and selecting it would re-render the status bar on every batch. Likewise `s.tab` is replaced by every view-state
  // commit (FB-I2).
  const hasTab = useStore(store, (s) => s.tab !== null);
  const runtime = useStore(store, (s) => s.tab?.runtime);
  const language = useStore(store, (s) => s.tab?.language);
  const orientation = useStore(store, (s) => s.tab?.layout.orientation);
  const webviewVisible = useStore(store, (s) => s.tab?.layout.tiles.webviewVisible ?? false);
  // spec §7.1: the Web View tile -- and the <electrobun-webview> it hosts -- exists only for a runtime that can
  // actually run in one; `bun` never gets one (see OutputTiles.tsx).
  const webviewSupported = runtime !== undefined && runtime !== "bun";
  const workingDirectory = useStore(store, (s) => s.tab?.workingDirectory ?? null);
  // R24-2, fix round 1 (I-1/M-2): an O(1) read of the store-derived flag, instead of scanning `entries` on every
  // render. The flag itself is kept current in `store.ts` (`withWorkingDirectoryMissing`, `applyTabUpdate`).
  const wdMissing = useStore(store, (s) => s.output.workingDirectoryMissing && !s.output.stale);
  const runState = useStore(store, (s) => s.output.runState);
  const activeHandles = useStore(store, (s) => s.output.activeHandles);
  const safeMode = useStore(store, (s) => s.safeMode.active);
  const autoRunArmed = useStore(store, (s) => s.autoRunArmed);
  const cursor = useStore(store, (s) => s.cursor);
  const vimMode = useStore(store, (s) => s.vimMode);
  const message = useStore(store, (s) => s.statusMessage);
  if (!hasTab) return null;
  const label = runStateLabel({ state: runState, activeHandles, autoRunArmed, safeMode, keys: runKeys });
  return (
    <footer className="status-bar">
      <div className="status-left">
        <span className={`status-state state-${runStateKind(runState)}`}>
          <i className="status-dot" aria-hidden="true" />
          <span data-testid="run-status">{label}</span>
        </span>
        {safeMode && <span className="status-badge">{strings.shell.safeMode}</span>}
        {message && <span className="status-message">{message}</span>}
      </div>
      <div className="status-right">
        <select
          aria-label={strings.shell.runtime}
          value={runtime}
          onChange={(event) => store.getState().setRuntime(event.target.value as Runtime)}
        >
          {RUNTIMES.map((runtime) => (
            <option
              key={runtime}
              value={runtime}
              disabled={!isRuntimeAvailable(runtime)}
              title={isRuntimeAvailable(runtime) ? undefined : strings.shell.laterMilestone}
            >
              {RUNTIME_LABELS[runtime]}
            </option>
          ))}
        </select>
        <select
          aria-label={strings.shell.language}
          value={language}
          onChange={(event) => store.getState().setLanguage(event.target.value as Language)}
        >
          {LANGUAGES.map((language) => (
            <option key={language} value={language}>
              {LANGUAGE_LABELS[language]}
            </option>
          ))}
        </select>
        <button type="button" className="status-item" onClick={onToggleLayout}>
          {orientation === "horizontal" ? strings.shell.split.horizontal : strings.shell.split.vertical}
        </button>
        <button
          type="button"
          className="status-item"
          disabled={!webviewSupported}
          title={webviewSupported ? undefined : strings.shell.webView.unavailable}
          onClick={onToggleWebView}
        >
          {/* Fix round 1 (F6): a bun tab has nothing to hide, even if `webviewVisible` is still true from before
              its runtime was switched away from a web one -- the label must say so, not "Hide". */}
          {webviewSupported && webviewVisible ? strings.shell.webView.hide : strings.shell.webView.show}
        </button>
        {workingDirectory ? (
          <span className="status-wd">
            <button
              type="button"
              className={`status-item${wdMissing ? " status-wd-missing" : ""}`}
              title={workingDirectory}
              aria-label={
                wdMissing
                  ? strings.shell.workingDirectory.missing(workingDirectory)
                  : strings.shell.workingDirectory.change(workingDirectory)
              }
              onClick={onPickWorkingDirectory}
            >
              {baseName(workingDirectory)}
            </button>
            <button
              type="button"
              className="status-item status-wd-clear"
              title={strings.shell.workingDirectory.clear}
              aria-label={strings.shell.workingDirectory.clear}
              onClick={onClearWorkingDirectory}
            >
              ×
            </button>
          </span>
        ) : (
          <button
            type="button"
            className="status-item status-wd-empty"
            title={strings.shell.workingDirectory.setHelp}
            onClick={onPickWorkingDirectory}
          >
            {strings.shell.workingDirectory.set}
          </button>
        )}
        {vimMode && <span className="status-vim">{vimMode.toUpperCase()}</span>}
        {cursor && <span>{strings.shell.cursor(cursor.line, cursor.column)}</span>}
      </div>
    </footer>
  );
}
