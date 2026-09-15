import { describe, expect, mock, test } from "bun:test";
import { createUiFlushHandlers, createUiFlushWaiter } from "../src/main/ui-flush";

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
});
