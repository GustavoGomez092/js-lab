import { describe, expect, mock, test } from "bun:test";
import { afterUiFlush, createUiFlushHandlers, createUiFlushWaiter } from "../src/main/ui-flush";

type FlushOutcome = "flushed" | "timedOut" | "closed";

describe("UI state flush before quit (X1)", () => {
  test("resolves flushed when the UI acknowledges, timedOut when it doesn't, and closed without a window", async () => {
    let open = true;
    const send = mock(() => {});
    const waiter = createUiFlushWaiter({ send, isOpen: () => open, timeoutMs: 30 });
    const flushed = waiter.request();
    expect(send).toHaveBeenCalledTimes(1);
    waiter.received();
    expect(await flushed).toBe("flushed");
    expect(await waiter.request()).toBe("timedOut");
    open = false;
    expect(await waiter.request()).toBe("closed");
    expect(send).toHaveBeenCalledTimes(2);
  });

  test("the ui.stateFlushed handler validates its payload", () => {
    const received = mock(() => {});
    const log = mock(() => {});
    const handlers = createUiFlushHandlers({ received }, log);
    handlers.messages["ui.stateFlushed"]({});
    handlers.messages["ui.stateFlushed"]("junk");
    expect(received).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
  });

  // I-1a / M-1 (R-M3-T19-FIX-1): the stores flush only once the UI flush has settled, whatever its outcome.
  test("afterUiFlush runs its follow-up only after the UI flush settles, and even when it fails", async () => {
    for (const outcome of ["flushed", "timedOut", "closed"] as const) {
      let settle: (value: FlushOutcome) => void = () => {};
      const request = mock(
        () =>
          new Promise<FlushOutcome>((resolve) => {
            settle = resolve;
          }),
      );
      const then = mock(() => {});
      const done = afterUiFlush({ uiFlush: { request }, then })();
      await Bun.sleep(1);
      expect(request).toHaveBeenCalledTimes(1);
      expect(then).not.toHaveBeenCalled();
      settle(outcome);
      await done;
      expect(then).toHaveBeenCalledTimes(1);
    }
    const then = mock(() => {});
    const failing = afterUiFlush({
      uiFlush: { request: () => Promise.reject(new Error("no transport")) },
      then,
    })();
    await expect(failing).resolves.toBeUndefined();
    expect(then).toHaveBeenCalledTimes(1);
  });

  // I-1b (R-M3-T19-FIX-1): the real waiter and ack handler, with a fake UI that writes its buffer and then acks.
  test("the real waiter and ack handler let a UI buffer write land before the stores flush", async () => {
    const events: string[] = [];
    const log = mock(() => {});
    const waiter = createUiFlushWaiter({
      send: () =>
        queueMicrotask(() => {
          events.push("buffer");
          handlers.messages["ui.stateFlushed"]({});
        }),
      isOpen: () => true,
      timeoutMs: 5000,
    });
    const handlers = createUiFlushHandlers(waiter, log);
    const started = performance.now();
    await afterUiFlush({
      uiFlush: waiter,
      // biome-ignore lint/suspicious/noThenProperty: afterUiFlush's deps object is never awaited or returned (R-M3-T19-FIX-1 names it `then`)
      then: () => {
        events.push("stores");
      },
    })();
    expect(events).toEqual(["buffer", "stores"]);
    // Well under the 5000 ms waiter timeout: the ack path resolved the wait, not the timer.
    expect(performance.now() - started).toBeLessThan(1000);
  }, 10000);
});
