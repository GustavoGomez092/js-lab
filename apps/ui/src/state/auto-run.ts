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
 * Debounces runs after code, language or runtime changes (spec §4.2, §5.2). Nothing runs until auto-run is armed --
 * by an edit, or (M4 Task 9) by the runtime switch itself, since spec §5.2 states a runtime change triggers a run
 * unconditionally, not only on an already-dirty tab -- and nothing runs in Safe Mode (spec §5.14). The guard is
 * re-checked both when scheduling and when the timer fires, and a pending timer is cancelled the moment the guard
 * stops holding (Safe Mode engages, Auto Run is turned off, or `hydrate()` disarms it) so a stale timer never runs
 * code the guard would now reject.
 * Returns an unsubscribe function that also exposes `cancelPending()` (fix round 1, I-1), so a caller that
 * already covers a pending edit (for example a manual run that just formatted the code) can cancel the
 * timer that edit armed without tearing down the subscription.
 */
export function startAutoRun(
  store: AppStore,
  run: () => void,
  timers: TimerApi = defaultTimers,
): (() => void) & { cancelPending(): void } {
  let pending: unknown = null;
  const cancel = () => {
    if (pending !== null) timers.clearTimeout(pending);
    pending = null;
  };
  const unsubscribe = store.subscribe((state, previous) => {
    // Switching tabs changes the mirrored code but is not an edit (spec §5.14). A debounce pending for the tab being
    // left must not fire and run the tab being shown, so cancel it, like every other case where the guard stops holding.
    if (state.activeTabId !== previous.activeTabId) {
      cancel();
      return;
    }
    if (!shouldAutoRun(state)) {
      cancel();
      return;
    }
    const changed =
      state.code !== previous.code ||
      state.tab?.language !== previous.tab?.language ||
      state.tab?.runtime !== previous.tab?.runtime;
    if (!changed) return;
    cancel();
    pending = timers.setTimeout(() => {
      pending = null;
      if (shouldAutoRun(store.getState())) run();
    }, state.settings?.run.autoRunDelayMs ?? 300);
  });
  return Object.assign(
    () => {
      cancel();
      unsubscribe();
    },
    { cancelPending: cancel },
  );
}
