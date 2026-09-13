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
 * and nothing runs in Safe Mode (spec §5.14). The guard is re-checked both when scheduling and when the timer
 * fires, and a pending timer is cancelled the moment the guard stops holding (Safe Mode engages, Auto Run is
 * turned off, or `hydrate()` disarms it) so a stale timer never runs code the guard would now reject.
 * Returns an unsubscribe function.
 */
export function startAutoRun(store: AppStore, run: () => void, timers: TimerApi = defaultTimers): () => void {
  let pending: unknown = null;
  const cancel = () => {
    if (pending !== null) timers.clearTimeout(pending);
    pending = null;
  };
  const unsubscribe = store.subscribe((state, previous) => {
    if (!shouldAutoRun(state)) {
      cancel();
      return;
    }
    const changed = state.code !== previous.code || state.tab?.language !== previous.tab?.language;
    if (!changed) return;
    cancel();
    pending = timers.setTimeout(() => {
      pending = null;
      if (shouldAutoRun(store.getState())) run();
    }, state.settings?.run.autoRunDelayMs ?? 300);
  });
  return () => {
    cancel();
    unsubscribe();
  };
}
