import { isRuntimeAvailable, LANGUAGES, type Language, RUNTIMES, type Runtime } from "@jslab/shared";
import { useStore } from "zustand";
import type { AppStore } from "../state/store";
import { strings } from "../strings";
import { LANGUAGE_LABELS, RUNTIME_LABELS, runStateKind, runStateLabel } from "./labels";

export function StatusBar({ store, onToggleLayout }: { store: AppStore; onToggleLayout(): void }) {
  // As built (M1 T18 fix round): primitive selectors only. `s.output` is a new object on every run.events batch,
  // and selecting it would re-render the status bar on every batch. Likewise `s.tab` is replaced by every view-state
  // commit (FB-I2).
  const hasTab = useStore(store, (s) => s.tab !== null);
  const runtime = useStore(store, (s) => s.tab?.runtime);
  const language = useStore(store, (s) => s.tab?.language);
  const orientation = useStore(store, (s) => s.tab?.layout.orientation);
  const runState = useStore(store, (s) => s.output.runState);
  const activeHandles = useStore(store, (s) => s.output.activeHandles);
  const safeMode = useStore(store, (s) => s.safeMode.active);
  const autoRunArmed = useStore(store, (s) => s.autoRunArmed);
  const cursor = useStore(store, (s) => s.cursor);
  const vimMode = useStore(store, (s) => s.vimMode);
  const message = useStore(store, (s) => s.statusMessage);
  if (!hasTab) return null;
  const label = runStateLabel({ state: runState, activeHandles, autoRunArmed, safeMode });
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
        {vimMode && <span className="status-vim">{vimMode.toUpperCase()}</span>}
        {cursor && <span>{strings.shell.cursor(cursor.line, cursor.column)}</span>}
      </div>
    </footer>
  );
}
