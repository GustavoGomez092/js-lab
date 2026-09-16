import { expect, test } from "bun:test";
import { type RunnerWebGlobal, startRunnerWeb } from "../src/bootstrap";

/**
 * Regression test for a bug that only ever appeared in a real page, and that every other test in this package was
 * structurally unable to catch.
 *
 * `startRunnerWeb` captures the unwrapped timers before `installHandleTracking` replaces them, and then calls them
 * as methods of the plain objects holding them (`rawInterval.setInterval(...)`, `timers.setTimeout(...)`). That
 * makes `this` the holder object rather than the Window. `setInterval` and `setTimeout` are WebIDL operations, and
 * WebKit rejects a receiver that isn't the Window with "Illegal invocation" -- which lands between installing the
 * host bridge and `bridge.send({ type: "ready" })`, so the page never reports ready and the host can do nothing
 * but time out. Bun ignores the receiver entirely, so every unit test (and `bootstrap.test.ts`, which deliberately
 * runs against the real `globalThis`) passed while a browser-mode run could not start at all.
 *
 * Reproducing WebKit's receiver check under Bun is not possible, so this pins the mechanism instead: the timers
 * must be invoked with the global as their receiver. Before the fix this records the private holder object; after
 * it, the global itself.
 */
test("the bootstrap calls its captured timers with the global as the receiver, not a holder object", () => {
  const receivers: unknown[] = [];
  const real = globalThis;

  const fake = {
    setTimeout(this: unknown, fn: () => void, ms?: number) {
      receivers.push(this);
      return real.setTimeout(fn, ms);
    },
    clearTimeout(this: unknown, id: unknown) {
      return real.clearTimeout(id as ReturnType<typeof setTimeout>);
    },
    setInterval(this: unknown, fn: () => void, ms?: number) {
      receivers.push(this);
      return real.setInterval(fn, ms);
    },
    clearInterval(this: unknown, id: unknown) {
      return real.clearInterval(id as ReturnType<typeof setInterval>);
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    console,
    fetch: real.fetch,
    WebSocket: real.WebSocket,
    __electrobunSendToHost: () => {},
    // biome-ignore lint/suspicious/noExplicitAny: a stand-in global, exactly as handles.test.ts builds one
  } as any;

  // The heartbeat interval is started before `ready` is sent, so bootstrapping alone exercises the call.
  const handle = startRunnerWeb({ global: fake as RunnerWebGlobal, heartbeatMs: 10_000 });
  try {
    expect(receivers.length).toBeGreaterThan(0);
    // The load-bearing assertion: every captured-timer call must see the global, never a holder object.
    for (const receiver of receivers) expect(receiver).toBe(fake);
  } finally {
    handle.dispose();
  }
});
