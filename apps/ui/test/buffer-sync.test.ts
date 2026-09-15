import { describe, expect, mock, test } from "bun:test";
import type { TimerApi } from "../src/state/auto-run";
import { createBufferSync } from "../src/state/buffer-sync";

function manualTimers() {
  let next = 1;
  let armedCount = 0;
  const pending = new Map<number, () => void>();
  const timers: TimerApi = {
    setTimeout: (callback) => {
      armedCount++;
      const id = next++;
      pending.set(id, callback);
      return id;
    },
    clearTimeout: (id) => {
      pending.delete(id as number);
    },
  };
  const fire = () => {
    for (const [id, callback] of [...pending.entries()]) {
      pending.delete(id);
      callback();
    }
  };
  return { timers, fire, armed: () => armedCount };
}

describe("buffer sync (X5)", () => {
  test("coalesces edits per tab and sends each tab's last content once after the delay", () => {
    const send = mock((_tabId: string, _content: string) => {});
    const { timers, fire } = manualTimers();
    const sync = createBufferSync(send, { timers });
    sync.changed("a", "1");
    sync.changed("a", "12");
    sync.changed("b", "x");
    sync.changed("a", "123");
    expect(send).not.toHaveBeenCalled();
    fire();
    // M-3 throttle: tab a's timer was armed by its first edit, before b's, so a is sent first (with its last content).
    expect(send.mock.calls).toEqual([
      ["a", "123"],
      ["b", "x"],
    ]);
  });

  test("flush sends one tab, or every tab, at once and cancels their timers", () => {
    const send = mock((_tabId: string, _content: string) => {});
    const { timers, fire } = manualTimers();
    const sync = createBufferSync(send, { timers });
    sync.changed("a", "1");
    sync.changed("b", "2");
    sync.flush("a");
    expect(send.mock.calls).toEqual([["a", "1"]]);
    sync.flush();
    fire();
    expect(send.mock.calls).toEqual([
      ["a", "1"],
      ["b", "2"],
    ]);
  });

  // M-3 (R-M3-T19-FIX-1): a throttle, not a debounce. A pending tab keeps its timer and only takes the newer content.
  test("sustained edits are sent every 150 ms with the latest content, not only after a pause", () => {
    const send = mock((_tabId: string, _content: string) => {});
    const { timers, fire, armed } = manualTimers();
    const sync = createBufferSync(send, { timers });
    sync.changed("t1", "a");
    expect(armed()).toBe(1);
    sync.changed("t1", "ab");
    expect(armed()).toBe(1);
    fire();
    expect(send.mock.calls).toEqual([["t1", "ab"]]);
    sync.changed("t1", "abc");
    fire();
    expect(send.mock.calls).toEqual([
      ["t1", "ab"],
      ["t1", "abc"],
    ]);
  });

  test("dispose drops pending edits", () => {
    const send = mock(() => {});
    const { timers, fire } = manualTimers();
    const sync = createBufferSync(send, { timers });
    sync.changed("a", "1");
    sync.dispose();
    fire();
    sync.flush();
    expect(send).not.toHaveBeenCalled();
  });
});
