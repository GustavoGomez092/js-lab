import { emptyParamsSchema } from "@jslab/rpc-schema";
import { createValidators, type Log } from "./rpc/validate";

/** X1: how long quit waits for the UI to flush view state and buffer edits (inside the 2 s quit bound). */
export const UI_FLUSH_TIMEOUT_MS = 500;

export interface UiFlushWaiter {
  request(): Promise<"flushed" | "timedOut" | "closed">;
  received(): void;
}

export function createUiFlushWaiter(deps: { send(): void; isOpen(): boolean; timeoutMs?: number }): UiFlushWaiter {
  let waiting: (() => void)[] = [];
  return {
    request() {
      if (!deps.isOpen()) return Promise.resolve("closed");
      return new Promise((resolve) => {
        const done = () => {
          clearTimeout(timer);
          resolve("flushed");
        };
        const timer = setTimeout(() => {
          waiting = waiting.filter((entry) => entry !== done);
          resolve("timedOut");
        }, deps.timeoutMs ?? UI_FLUSH_TIMEOUT_MS);
        waiting.push(done);
        deps.send();
      });
    },
    received() {
      const current = waiting;
      waiting = [];
      for (const done of current) done();
    },
  };
}

/** Waits for the UI to flush (flushed, timed out, closed or failed), then runs `then` exactly once (X1, R-M3-T19-FIX-1). */
export function afterUiFlush(deps: {
  uiFlush: Pick<UiFlushWaiter, "request">;
  then: () => unknown;
}): () => Promise<void> {
  return async () => {
    await deps.uiFlush.request().catch(() => "failed" as const);
    await deps.then();
  };
}

export function createUiFlushHandlers(waiter: Pick<UiFlushWaiter, "received">, log: Log) {
  const { message } = createValidators(log);
  return {
    requests: {},
    messages: { "ui.stateFlushed": message(emptyParamsSchema, "ui.stateFlushed", () => waiter.received()) },
  };
}
