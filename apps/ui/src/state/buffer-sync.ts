import type { TimerApi } from "./auto-run";

/** X5: at most one full-buffer `buffer.changed` per tab per this many ms while typing. */
export const BUFFER_SYNC_DELAY_MS = 150;

export interface BufferSync {
  changed(tabId: string, content: string): void;
  /** Sends one tab's pending content (or every tab's) now. */
  flush(tabId?: string): void;
  dispose(): void;
}

const defaultTimers: TimerApi = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Coalesces buffer edits per tab before they reach Main (X5); Main debounces its disk writes separately. */
export function createBufferSync(
  send: (tabId: string, content: string) => void,
  options: { delayMs?: number; timers?: TimerApi } = {},
): BufferSync {
  const timers = options.timers ?? defaultTimers;
  const pending = new Map<string, { content: string; handle: unknown }>();
  const flushOne = (tabId: string) => {
    const entry = pending.get(tabId);
    if (!entry) return;
    timers.clearTimeout(entry.handle);
    pending.delete(tabId);
    send(tabId, entry.content);
  };
  return {
    changed(tabId, content) {
      const existing = pending.get(tabId);
      if (existing) timers.clearTimeout(existing.handle);
      pending.set(tabId, {
        content,
        handle: timers.setTimeout(() => flushOne(tabId), options.delayMs ?? BUFFER_SYNC_DELAY_MS),
      });
    },
    flush(tabId) {
      if (tabId !== undefined) flushOne(tabId);
      else for (const id of [...pending.keys()]) flushOne(id);
    },
    dispose() {
      for (const entry of pending.values()) timers.clearTimeout(entry.handle);
      pending.clear();
    },
  };
}
