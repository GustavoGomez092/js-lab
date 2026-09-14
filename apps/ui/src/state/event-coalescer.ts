import type { RunEvent } from "@jslab/rpc-schema";

export interface EventCoalescer {
  push(tabId: string, runId: string, events: RunEvent[]): void;
  /** Applies what is queued for one tab (or every tab) now. Call it before a state or diagnostics message. */
  flush(tabId?: string): void;
}

/**
 * `applyRunEvents` copies a tab's entry list for every `run.events` message (final review M12, T15), so messages that
 * arrive within one frame are merged per tab and run and applied once per frame.
 */
export function createEventCoalescer(
  apply: (tabId: string, runId: string, events: RunEvent[]) => void,
  scheduleFrame: (callback: () => void) => void,
): EventCoalescer {
  const pending = new Map<string, { runId: string; events: RunEvent[] }[]>();
  let scheduled = false;

  const flushTab = (tabId: string) => {
    const batches = pending.get(tabId);
    if (!batches) return;
    pending.delete(tabId);
    for (const batch of batches) apply(tabId, batch.runId, batch.events);
  };

  const flushAll = () => {
    scheduled = false;
    for (const tabId of [...pending.keys()]) flushTab(tabId);
  };

  return {
    push(tabId, runId, events) {
      const batches = pending.get(tabId) ?? [];
      const last = batches[batches.length - 1];
      if (last && last.runId === runId) last.events.push(...events);
      else batches.push({ runId, events: [...events] });
      pending.set(tabId, batches);
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
