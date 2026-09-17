import { expect, test } from "bun:test";
import type { RunnerState } from "@jslab/rpc-schema";
import { HandleTracker, handleCountAction, installHandleTracking } from "../src/handles";

// biome-ignore lint/suspicious/noExplicitAny: sandboxed global object
function sandbox(): { tracker: HandleTracker; g: any } {
  const tracker = new HandleTracker(() => {});
  const g = {
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    setImmediate,
    clearImmediate,
    fetch,
    WebSocket,
    Bun: { serve: Bun.serve },
  };
  installHandleTracking(tracker, g);
  return { tracker, g };
}

function webSocketServer() {
  return Bun.serve({
    port: 0,
    fetch: (req, server) => (server.upgrade(req) ? undefined : new Response("no upgrade", { status: 400 })),
    websocket: { message: () => {} },
  });
}

test("a WebSocket is tracked from construction until it closes", async () => {
  const server = webSocketServer();
  try {
    const { tracker, g } = sandbox();
    const socket = new g.WebSocket(`ws://127.0.0.1:${server.port}/`);
    expect(socket).toBeInstanceOf(WebSocket);
    expect(tracker.count).toBe(1);
    await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));
    const closed = new Promise((resolve) => socket.addEventListener("close", resolve, { once: true }));
    socket.close();
    await closed;
    expect(tracker.count).toBe(0);
  } finally {
    server.stop(true);
  }
});

test("disposeAll closes tracked WebSockets", async () => {
  const server = webSocketServer();
  try {
    const { tracker, g } = sandbox();
    const socket = new g.WebSocket(`ws://127.0.0.1:${server.port}/`);
    await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));
    const closed = new Promise((resolve) => socket.addEventListener("close", resolve, { once: true }));
    tracker.disposeAll();
    await closed;
    expect(socket.readyState).toBe(WebSocket.CLOSED);
    expect(tracker.count).toBe(0);
  } finally {
    server.stop(true);
  }
});

test("a WebSocket that fails to connect is no longer tracked", async () => {
  const { tracker, g } = sandbox();
  // Port 1 refuses connections, so the socket errors and closes without ever opening.
  const socket = new g.WebSocket("ws://127.0.0.1:1/");
  expect(tracker.count).toBe(1);
  await new Promise((resolve) => socket.addEventListener("close", resolve, { once: true }));
  expect(tracker.count).toBe(0);
});

test("a timeout is tracked until it fires", async () => {
  const { tracker, g } = sandbox();
  g.setTimeout(() => {}, 5);
  expect(tracker.count).toBe(1);
  await Bun.sleep(30);
  expect(tracker.count).toBe(0);
});

test("clearTimeout stops tracking", () => {
  const { tracker, g } = sandbox();
  const id = g.setTimeout(() => {}, 1000);
  g.clearTimeout(id);
  expect(tracker.count).toBe(0);
});

test("an interval is tracked until cleared", () => {
  const { tracker, g } = sandbox();
  const id = g.setInterval(() => {}, 1000);
  expect(tracker.count).toBe(1);
  g.clearInterval(id);
  expect(tracker.count).toBe(0);
});

test("disposeAll stops tracked intervals", async () => {
  const { tracker, g } = sandbox();
  let ticks = 0;
  g.setInterval(() => ticks++, 5);
  await Bun.sleep(30);
  tracker.disposeAll();
  const after = ticks;
  await Bun.sleep(30);
  expect(ticks).toBe(after);
  expect(tracker.count).toBe(0);
});

test("fetch is tracked until it settles", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: async () => {
      await Bun.sleep(20);
      return new Response("ok");
    },
  });
  try {
    const { tracker, g } = sandbox();
    const pending = g.fetch(`http://localhost:${server.port}/`);
    expect(tracker.count).toBe(1);
    expect(await (await pending).text()).toBe("ok");
    expect(tracker.count).toBe(0);
  } finally {
    server.stop(true);
  }
});

test("Bun.serve servers are tracked until stopped", () => {
  const { tracker, g } = sandbox();
  const server = g.Bun.serve({ port: 0, fetch: () => new Response("ok") });
  expect(tracker.count).toBe(1);
  server.stop(true);
  expect(tracker.count).toBe(0);
});

test("adding the same key twice counts once and notifies on change", () => {
  const counts: number[] = [];
  const tracker = new HandleTracker((count) => counts.push(count));
  const key = {};
  tracker.add(key, () => {});
  tracker.add(key, () => {});
  tracker.remove(key);
  expect(counts).toEqual([1, 0]);
});

test("a child process that fails to spawn is no longer tracked", async () => {
  const tracker = new HandleTracker(() => {});
  const g = {
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    setImmediate,
    clearImmediate,
    fetch,
    Bun: { serve: Bun.serve },
  };
  installHandleTracking(tracker, g);

  let errorFired = false;
  // biome-ignore lint/suspicious/noExplicitAny: test variable
  let child: any;
  const errorPromise = new Promise<void>((resolve) => {
    // Accessing child_process through require like handles.ts does
    const cp = require("node:child_process");
    child = cp.spawn("jslab-definitely-missing-binary-xyz", []);
    child.once("error", () => {
      errorFired = true;
      resolve();
    });
  });

  // Verify the wrapper doesn't add an error listener (only user's listener)
  expect(child.listenerCount("error")).toBe(1);

  await errorPromise;
  expect(errorFired).toBe(true);
  await Bun.sleep(10);
  expect(tracker.count).toBe(0);
});

test("handleCountAction disposes new handles after a stop or a caught process.exit, and tracks idle/settled otherwise", () => {
  const cases: Array<[Parameters<typeof handleCountAction>[0], boolean, number, ReturnType<typeof handleCountAction>]> =
    [
      ["evaluating", true, 1, "dispose"],
      ["settled", true, 2, "dispose"],
      ["stopped", false, 1, "dispose"],
      ["evaluating", false, 1, null],
      ["settled", false, 0, "idle"],
      ["idle", false, 1, "settled"],
      ["stopped", false, 0, null],
      ["evaluating", true, 0, null],
    ];
  for (const [state, exiting, count, expected] of cases) {
    expect(handleCountAction(state, exiting, count)).toBe(expected);
  }
});

/**
 * The same M4 defect fixed in the web runner (388f865), which was present here unchanged: a self-rescheduling
 * `setTimeout` chain or `setImmediate` re-arm strobing the run state.
 *
 * Every sandbox above constructs `new HandleTracker(() => {})` -- it throws the notifications away and asserts only
 * `tracker.count` *at rest*. That is precisely why this went unseen: at rest the count really is 1 and everything
 * above passes. The defect lives entirely in the transitions emitted *between* two resting points, so these tests
 * record the emitted sequence rather than the final state.
 */

/** Deterministic stand-ins for the host timers, so a "tick" is an explicit `fire()` rather than a real delay. */
function fakeTimers() {
  let nextId = 1;
  const callbacks = new Map<number, () => void>();
  const schedule = (cb: () => void) => {
    const id = nextId++;
    callbacks.set(id, cb);
    return id;
  };
  return {
    setTimeout: (cb: () => void, _ms?: number) => schedule(cb),
    clearTimeout: (id: number) => void callbacks.delete(id),
    setInterval: (cb: () => void, _ms?: number) => schedule(cb),
    clearInterval: (id: number) => void callbacks.delete(id),
    setImmediate: (cb: () => void) => schedule(cb),
    clearImmediate: (id: number) => void callbacks.delete(id),
    /** Runs everything currently due; anything a callback schedules lands in the *next* round, as a real loop does. */
    fire: () => {
      const due = [...callbacks];
      callbacks.clear();
      for (const [, cb] of due) cb();
    },
    pending: () => callbacks.size,
  };
}

/**
 * `bootstrap.ts`'s own tracker wiring, verbatim:
 *
 *     const tracker = new HandleTracker((count) => {
 *       if (!run) return;
 *       const action = handleCountAction(run.state, exiting, count);
 *       if (action === "dispose") tracker.disposeAll();
 *       else if (action) setState(action);
 *     });
 *
 * and `setState` assigns `run.state` and then sends one `state` message to Main. So `states` below is exactly the
 * sequence of `state` messages a real runner process would put on the IPC channel, which is what the UI re-renders
 * from -- not a proxy for it.
 */
function stateRecordingSandbox(initial: RunnerState) {
  const states: RunnerState[] = [];
  const run = { state: initial };
  const tracker: HandleTracker = new HandleTracker((count) => {
    const action = handleCountAction(run.state, false, count);
    if (action === "dispose") tracker.disposeAll();
    else if (action) {
      run.state = action;
      states.push(action);
    }
  });
  const timers = fakeTimers();
  const g = {
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
    setImmediate: timers.setImmediate,
    clearImmediate: timers.clearImmediate,
    // biome-ignore lint/suspicious/noExplicitAny: sandboxed global object
  } as any;
  installHandleTracking(tracker, g);
  return { states, run, tracker, timers, g };
}

// The loop itself. A run that ended `settled` with one timer pending -- any ordinary polling or animation chain --
// used to emit an `idle` and a `settled` on EVERY tick, because the wrapper retired the timer before running the
// callback that reschedules it, dipping the count 1 -> 0 -> 1. `settled` is in the UI's BUSY_STATES and `idle` is
// not, so `busy` flipped twice a tick and remounted the spinner (restarting its CSS animation) with it.
test("a self-rescheduling setTimeout chain emits no state messages at all while it keeps looping", () => {
  const { states, tracker, timers, g } = stateRecordingSandbox("settled");
  const tick = () => {
    g.setTimeout(tick, 16);
  };
  g.setTimeout(tick, 16);
  states.length = 0;

  for (let round = 0; round < 5; round += 1) timers.fire();

  // Asserting the exact sequence, not "contains no idle" or "the last one is settled": the whole defect is extra
  // transitions, so a superset assertion would accept the broken state (five idle/settled pairs) as a pass.
  expect(states).toEqual([]);
  expect(tracker.count).toBe(1);
});

test("a self-rescheduling setImmediate chain emits no state messages at all while it keeps looping", () => {
  const { states, tracker, timers, g } = stateRecordingSandbox("settled");
  const tick = () => {
    g.setImmediate(tick);
  };
  g.setImmediate(tick);
  states.length = 0;

  for (let round = 0; round < 5; round += 1) timers.fire();

  expect(states).toEqual([]);
  expect(tracker.count).toBe(1);
});

// The other half: holding the notification for the callback's duration must not SUPPRESS the real transition. A
// chain that stops rescheduling has genuinely gone idle on that tick, and must say so -- exactly once.
test("a setTimeout chain that stops rescheduling still reports idle, exactly once", () => {
  const { states, tracker, timers, g } = stateRecordingSandbox("settled");
  let ticks = 0;
  const tick = () => {
    ticks += 1;
    if (ticks < 3) g.setTimeout(tick, 16);
  };
  g.setTimeout(tick, 16);
  states.length = 0;

  timers.fire(); // reschedules
  timers.fire(); // reschedules
  timers.fire(); // does not reschedule: the run is genuinely idle now

  expect(ticks).toBe(3);
  expect(states).toEqual(["idle"]);
  expect(tracker.count).toBe(0);
});

// The control. This one passes with and without `batch()` -- a one-shot never re-registers, so there is no dip to
// collapse. That is the point: it proves the fix reports genuine idle rather than silencing the messages.
test("a one-shot setImmediate still reports idle, exactly once", () => {
  const { states, tracker, timers, g } = stateRecordingSandbox("settled");
  g.setImmediate(() => {});
  states.length = 0;

  timers.fire();

  expect(states).toEqual(["idle"]);
  expect(tracker.count).toBe(0);
});
