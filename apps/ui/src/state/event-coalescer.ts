import type { RunEvent } from "@jslab/rpc-schema";

export interface EventCoalescer {
  push(tabId: string, runId: string, events: RunEvent[]): void;
  /** Applies what is queued for one tab (or every tab) now. Call it before a state or diagnostics message. */
  flush(tabId?: string): void;
}

/** A tab whose queue passes this many events is applied at once, without waiting for a frame (FB-I1). */
export const MAX_QUEUED_EVENTS = 2000;
/** The longest a queue waits for a frame. WebKit suspends rAF while the window is hidden (FB-I1). */
export const FLUSH_TIMEOUT_MS = 100;

/**
 * `applyRunEvents` copies a tab's entry list for every `run.events` message (final review M12, T15), so messages that
 * arrive within one frame are merged per tab and run and applied once per frame. A frame may never come while the
 * window is hidden, so a tab's queue is also applied as soon as it holds more than `maxQueuedEvents` (FB-I1).
 */
export function createEventCoalescer(
  apply: (tabId: string, runId: string, events: RunEvent[]) => void,
  scheduleFrame: (callback: () => void) => void,
  maxQueuedEvents = MAX_QUEUED_EVENTS,
): EventCoalescer {
  const pending = new Map<string, { batches: { runId: string; events: RunEvent[] }[]; count: number }>();
  let scheduled = false;

  const flushTab = (tabId: string) => {
    const queue = pending.get(tabId);
    if (!queue) return;
    pending.delete(tabId);
    for (const batch of queue.batches) apply(tabId, batch.runId, batch.events);
  };

  const flushAll = () => {
    scheduled = false;
    for (const tabId of [...pending.keys()]) flushTab(tabId);
  };

  return {
    push(tabId, runId, events) {
      const queue = pending.get(tabId) ?? { batches: [], count: 0 };
      const last = queue.batches[queue.batches.length - 1];
      if (last && last.runId === runId) last.events.push(...events);
      else queue.batches.push({ runId, events: [...events] });
      queue.count += events.length;
      pending.set(tabId, queue);
      if (queue.count > maxQueuedEvents) {
        flushTab(tabId);
        return;
      }
      if (scheduled) return;
      scheduled = true;
      scheduleFrame(flushAll);
    },
    flush(tabId) {
      if (tabId === undefined) flushAll();
      else flushTab(tabId);
    },
  };
}

export interface FrameSchedulerDeps {
  requestFrame(callback: () => void): void;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  timeoutMs?: number;
}

/** Runs each callback once, on the next animation frame or after `timeoutMs`, whichever comes first (FB-I1). */
export function createFrameScheduler(deps: FrameSchedulerDeps): (callback: () => void) => void {
  return (callback) => {
    let done = false;
    const run = () => {
      if (done) return;
      done = true;
      deps.clearTimeout(timer);
      callback();
    };
    const timer = deps.setTimeout(run, deps.timeoutMs ?? FLUSH_TIMEOUT_MS);
    deps.requestFrame(run);
  };
}
