import { expect, test } from "bun:test";
import { type RunnerWebGlobal, startRunnerWeb } from "../src/bootstrap";

/**
 * Pins a platform contract, not a diagnosed bug.
 *
 * `startRunnerWeb` captures the unwrapped timers before `installHandleTracking` replaces them, and then calls them
 * as methods of the plain objects holding them (`rawInterval.setInterval(...)`, `timers.setTimeout(...)`), which
 * would make `this` the holder object rather than the Window. Binding them to the global is correct on the
 * platform contract regardless: `setTimeout`/`setInterval` are WebIDL operations, whose receiver is specified to
 * be the Window. That is why the binding stays, and that is all this test asserts.
 *
 * **What this test does NOT establish, despite what it used to claim.** It previously stated as fact that an
 * unbound receiver throws "Illegal invocation" in WebKit and that this was why a browser-mode page never reported
 * ready. Task 9a's own in-page probe of the exact call shape contradicted that: it returned `method-ok`, and the
 * emitted bundle is not strict-mode. Why the probe reported that is still unexplained. The hang that prompted the
 * original claim turned out to have a different cause entirely -- `packages/serializer`'s `jsonBytes` used Node's
 * `Buffer`, which a webview does not have (M4 Task 9b) -- so nothing here should be read as the explanation for it.
 *
 * Reproducing a WebKit receiver check under Bun is not possible, so this pins the observable property instead: the
 * captured timers must be invoked with the global as their receiver, never a holder object.
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
