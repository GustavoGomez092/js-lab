import type { CommandId } from "@jslab/shared";

export interface UiDispatch {
  /** Sends a UI command now if the view can receive it, otherwise queues it and opens the window. */
  dispatch(command: CommandId, args?: unknown): void;
  /** Called on every UI heartbeat: the first one after a (re)open means the view can receive commands. */
  markReady(): void;
  /** Called when the main window closes: whatever loads next has to report ready again. */
  markClosed(): void;
}

/**
 * `dispatchMenuAction` (menu.ts) drops a menu command issued while the window is closed, because the user can just
 * click again. A CLI command has no one to click again, so it waits here instead — bounded, so a view that never
 * boots can't grow the queue.
 */
export function createUiDispatch(deps: {
  isOpen(): boolean;
  open(): void;
  send(message: { command: CommandId; args?: unknown }): void;
  maxPending?: number;
}): UiDispatch {
  const maxPending = deps.maxPending ?? 20;
  let pending: { command: CommandId; args?: unknown }[] = [];
  let ready = false;

  return {
    dispatch(command, args) {
      const message = args === undefined ? { command } : { command, args };
      if (ready && deps.isOpen()) {
        deps.send(message);
        return;
      }
      if (pending.length < maxPending) pending.push(message);
      if (!deps.isOpen()) deps.open();
    },
    markReady() {
      ready = true;
      const queued = pending;
      pending = [];
      for (const message of queued) deps.send(message);
    },
    markClosed() {
      ready = false;
    },
  };
}
