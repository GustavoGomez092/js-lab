import { describe, expect, mock, test } from "bun:test";
import type { TimerApi } from "../src/state/auto-run";
import { createBufferSync } from "../src/state/buffer-sync";

function manualTimers() {
  let next = 1;
  const pending = new Map<number, () => void>();
  const timers: TimerApi = {
    setTimeout: (callback) => {
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
  return { timers, fire };
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
    expect(send.mock.calls).toEqual([
      ["b", "x"],
      ["a", "123"],
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
