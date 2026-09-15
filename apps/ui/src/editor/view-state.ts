import type { TimerApi } from "../state/auto-run";

export type { TimerApi };

const defaultTimers: TimerApi = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Debounced per-tab view-state persistence (spec §10.1: session writes are debounced to 500 ms). */
export function createViewStateSaver(
  save: (tabId: string, viewState: unknown) => void,
  delayMs = 500,
  timers: TimerApi = defaultTimers,
) {
  const pending = new Map<string, { handle: unknown; viewState: unknown }>();

  const flushOne = (tabId: string) => {
    const entry = pending.get(tabId);
    if (!entry) return;
    timers.clearTimeout(entry.handle);
    pending.delete(tabId);
    save(tabId, entry.viewState);
  };

  return {
    schedule(tabId: string, viewState: unknown) {
      const existing = pending.get(tabId);
      if (existing) timers.clearTimeout(existing.handle);
      pending.set(tabId, { viewState, handle: timers.setTimeout(() => flushOne(tabId), delayMs) });
    },
    flush(tabId?: string) {
      if (tabId) flushOne(tabId);
      else for (const id of [...pending.keys()]) flushOne(id);
    },
    cancel(tabId: string) {
      const entry = pending.get(tabId);
      if (entry) timers.clearTimeout(entry.handle);
      pending.delete(tabId);
    },
  };
}
