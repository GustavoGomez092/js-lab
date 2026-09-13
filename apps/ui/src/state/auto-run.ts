import { type AppStore, shouldAutoRun } from "./store";

export interface TimerApi {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const defaultTimers: TimerApi = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Debounces runs after code or language changes (spec §4.2). Nothing runs until auto-run is armed by an edit,
 * and nothing runs in Safe Mode (spec §5.14). Returns an unsubscribe function.
 */
export function startAutoRun(store: AppStore, run: () => void, timers: TimerApi = defaultTimers): () => void {
  let pending: unknown = null;
  const unsubscribe = store.subscribe((state, previous) => {
    const changed = state.code !== previous.code || state.tab?.language !== previous.tab?.language;
    if (!changed || !shouldAutoRun(state)) return;
    if (pending !== null) timers.clearTimeout(pending);
    pending = timers.setTimeout(() => {
      pending = null;
      run();
    }, state.settings?.run.autoRunDelayMs ?? 300);
  });
  return () => {
    if (pending !== null) timers.clearTimeout(pending);
    unsubscribe();
  };
}
