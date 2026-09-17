import { expect, test } from "bun:test";
import type { WebToHostMessage } from "@jslab/rpc-schema";
import { type RunnerWebGlobal, startRunnerWeb } from "../src/bootstrap";

/**
 * The user-reported M4 defect, at the level the defect actually lives: **an idle `browser` tab with nothing
 * running strobed between `idle` and `settled` forever.**
 *
 * `handles.test.ts` already covers the tick-level half of this (a self-rescheduling rAF/timer loop must not dip
 * the count), and commit 388f865's `HandleTracker.batch` fixed that. This is the other half, and no fixture in
 * this package could see it, because every one of them models the outbound channel as a plain function that
 * appends to an array:
 *
 *     __electrobunSendToHost: (value) => sent.push(value.message)
 *
 * A real page's channel is not that. Electrobun's preload owns it: `initHostMessageBridge`
 * (`apps/desktop/.hutch/devkit/api/preload/events.ts`) installs `window.__electrobunSendToHost` as a call to
 * `emitWebviewEvent`, and `emitWebviewEvent` defers **every** emission through a bare `setTimeout(...)`. That
 * identifier is free, so it resolves on the global at call time — the tracked wrapper `installHandleTracking`
 * left there. So every outbound message registered a handle, and since one of the things the page sends is the
 * run state itself, `setState` → message → handle → state change → `setState` closed a loop that feeds itself:
 * `idle`, `settled`, `idle`, `settled`, … with no user code alive at all.
 *
 * `pageGlobal` below is therefore deliberately shaped like the preload rather than like an array append. That one
 * property is the whole fixture, which is why `channelUsedTrackedTimer` is asserted alongside the real assertion:
 * a refactor that stopped routing the channel through the page's own `setTimeout` would make this file vacuous
 * rather than failing, and the assertion is what stops that happening silently.
 */

/** How long an "idle window" is sampled for. The loop this pins ran at >1000 messages/second under Bun. */
const IDLE_WINDOW_MS = 300;

interface Page {
  g: RunnerWebGlobal;
  sent: WebToHostMessage[];
  /** How many times the outbound channel reached for the page's (tracked) `setTimeout`. */
  timerCalls: () => number;
}

/**
 * A page whose outbound host channel behaves exactly as Electrobun's preload does: it reads `setTimeout` off the
 * global **at call time** and defers the delivery through it.
 */
function pageGlobal(): Page {
  const sent: WebToHostMessage[] = [];
  let timerCalls = 0;
  // biome-ignore lint/suspicious/noExplicitAny: a stand-in global, exactly as handles.test.ts builds one
  const g: any = {
    setTimeout: ((fn: () => void, ms?: number) => setTimeout(fn, ms)) as unknown,
    clearTimeout: clearTimeout as unknown,
    setInterval: ((fn: () => void, ms?: number) => setInterval(fn, ms)) as unknown,
    clearInterval: clearInterval as unknown,
    addEventListener: () => {},
    removeEventListener: () => {},
    console: {},
  };
  g.__electrobunSendToHost = (value: unknown) => {
    timerCalls += 1;
    // Read from the global on every call, like the preload's free identifier -- NOT captured once up front.
    g.setTimeout(() => sent.push((value as { message: WebToHostMessage }).message));
  };
  return { g: g as RunnerWebGlobal, sent, timerCalls: () => timerCalls };
}

const send = (g: RunnerWebGlobal, seq: number, message: unknown) =>
  (g.__jslabHostMessage as (m: unknown) => void)({ seq, message });

/** Waits until `predicate` holds over the messages received so far, or throws with everything that arrived. */
async function until(sent: WebToHostMessage[], predicate: (sent: WebToHostMessage[]) => boolean, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate(sent)) {
    if (Date.now() > deadline) throw new Error(`timed out; received ${JSON.stringify(sent)}`);
    await Bun.sleep(2);
  }
}

const states = (sent: WebToHostMessage[]) =>
  sent.filter((m): m is Extract<WebToHostMessage, { type: "state" }> => m.type === "state");

/**
 * The defect itself. Before the fix this window contained hundreds of perfectly alternating `idle`/`settled`
 * messages; `toEqual([])` rather than a "no more than N" bound, because the whole defect is messages that should
 * not exist at all -- any tolerance would accept a slower strobe as a pass.
 */
test("an idle browser page sends no state messages at all once a run with no handles has finished", async () => {
  const page = pageGlobal();
  const handle = startRunnerWeb({ global: page.g, heartbeatMs: 10_000, runtime: "browser" });
  try {
    send(page.g, 1, { type: "run", runId: "run-1", code: "1 + 1;\n", settings: { maxEntries: 100 } });
    await until(page.sent, (sent) => states(sent).some((m) => m.state !== "evaluating"));
    expect(states(page.sent).at(-1)).toMatchObject({ state: "idle", activeHandles: 0 });

    // The run is over and held nothing. Everything after this point would be the page talking to itself.
    const from = page.sent.length;
    const callsBefore = page.timerCalls();
    await Bun.sleep(IDLE_WINDOW_MS);

    expect(states(page.sent.slice(from)).map((m) => m.state)).toEqual([]);
    // The fixture really did exercise the path this test exists for: the channel reached for the page's own
    // `setTimeout` for the messages it sent above. Without this, a future change could make the test vacuous.
    expect(callsBefore).toBeGreaterThan(0);
  } finally {
    handle.dispose();
  }
});

/**
 * The control that separates a fix from a silencer, at the bootstrap level: suspending tracking for JSLab's own
 * messages must not make the page blind to a handle the *run* creates. `g.setTimeout` is the same wrapped global
 * function user code reaches, so this registers a handle exactly as an ordinary `setTimeout(...)` in a run does --
 * and the page must report `settled` for it, then `idle` on the very tick it retires.
 */
test("a real handle created on an idle page still reports settled, then idle when it retires", async () => {
  const page = pageGlobal();
  const handle = startRunnerWeb({ global: page.g, heartbeatMs: 10_000, runtime: "browser" });
  try {
    send(page.g, 1, { type: "run", runId: "run-1", code: "1 + 1;\n", settings: { maxEntries: 100 } });
    await until(page.sent, (sent) => states(sent).some((m) => m.state === "idle"));
    const from = page.sent.length;

    (page.g.setTimeout as (fn: () => void, ms: number) => unknown)(() => {}, 20);
    await until(page.sent, (sent) => states(sent.slice(from)).some((m) => m.state === "idle"));

    expect(states(page.sent.slice(from)).map((m) => ({ state: m.state, activeHandles: m.activeHandles }))).toEqual([
      { state: "settled", activeHandles: 1 },
      { state: "idle", activeHandles: 0 },
    ]);
  } finally {
    handle.dispose();
  }
});
