import { expect, test } from "bun:test";
import type { RunnerState } from "@jslab/rpc-schema";
import { AudioController, HandleTracker, handleCountAction, installHandleTracking } from "../src/handles";

// The test environment (bun:test) has no DOM: every host API the web runner touches is a small fake built here,
// per the task brief ("build the fakes you need... rather than adding a DOM library").

/** `map.get(key)`, creating and storing an empty set first if there wasn't one. */
function bucket<K, V>(map: Map<K, Set<V>>, key: K): Set<V> {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  return set;
}

/** What `createGain()` returns: enough of a real `GainNode` for the mute wiring -- a `.gain` AudioParam-alike
 * with a settable `.value`, and a no-op `connect` (the fake never actually routes samples anywhere). */
class FakeGainNode {
  gain = { value: 1 };
  connect(_destination: unknown): void {}
}

class FakeAudioContext {
  /** `startSuspended` (fix round 1, M1): a real `AudioContext` created without a user gesture starts life
   * already `"suspended"` under autoplay policy -- the common case, not the rare one -- so tests need a way to
   * construct one that never passed through `"running"` at all, not just one that later calls `suspend()`. */
  state: "running" | "suspended" | "closed";
  /** The real destination `handles.ts` reads *before* it shadows `this.destination` with the inserted gain node. */
  destination = { kind: "real-destination" as const };
  #listeners = new Map<string, Set<() => void>>();
  constructor(startSuspended = false) {
    this.state = startSuspended ? "suspended" : "running";
  }
  addEventListener(type: string, cb: () => void): void {
    bucket(this.#listeners, type).add(cb);
  }
  removeEventListener(type: string, cb: () => void): void {
    this.#listeners.get(type)?.delete(cb);
  }
  #emit(type: string): void {
    for (const cb of this.#listeners.get(type) ?? []) cb();
  }
  createGain(): FakeGainNode {
    return new FakeGainNode();
  }
  async suspend(): Promise<void> {
    if (this.state !== "running") return;
    this.state = "suspended";
    this.#emit("statechange");
  }
  async resume(): Promise<void> {
    if (this.state !== "suspended") return;
    this.state = "running";
    this.#emit("statechange");
  }
  async close(): Promise<void> {
    if (this.state === "closed") return;
    this.state = "closed";
    this.#emit("statechange");
  }
}

class FakeMediaElement {
  paused = true;
  /** Fix round 1, M2: makes the next (only the next) `play()` call reject instead of resolve, the way a real
   * browser does when autoplay is blocked, the source is missing, or decoding fails. */
  rejectNextPlay = false;
  /** Task 9d: makes the next (only the next) `play()` call throw synchronously rather than return a promise at
   * all -- what a real element does for an InvalidStateError, and the one path `play.apply` left unguarded. */
  throwNextPlay = false;
  #listeners = new Map<string, Set<() => void>>();
  addEventListener(type: string, cb: () => void): void {
    bucket(this.#listeners, type).add(cb);
  }
  removeEventListener(type: string, cb: () => void): void {
    this.#listeners.get(type)?.delete(cb);
  }
  #emit(type: string): void {
    for (const cb of [...(this.#listeners.get(type) ?? [])]) cb();
  }
  play(): Promise<void> {
    if (this.throwNextPlay) {
      this.throwNextPlay = false;
      throw new Error("InvalidStateError");
    }
    if (this.rejectNextPlay) {
      this.rejectNextPlay = false;
      return Promise.reject(new Error("NotAllowedError"));
    }
    this.paused = false;
    return Promise.resolve();
  }
  pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.#emit("pause");
  }
  end(): void {
    this.paused = true;
    this.#emit("ended");
  }
}

function fakeRaf() {
  let nextId = 1;
  const callbacks = new Map<number, (time: number) => void>();
  return {
    requestAnimationFrame: (cb: (time: number) => void) => {
      const id = nextId++;
      callbacks.set(id, cb);
      return id;
    },
    cancelAnimationFrame: (id: number) => {
      callbacks.delete(id);
    },
    fire: () => {
      const due = [...callbacks];
      callbacks.clear();
      for (const [, cb] of due) cb(0);
    },
  };
}

function sandbox(): {
  tracker: HandleTracker;
  // biome-ignore lint/suspicious/noExplicitAny: sandboxed global object
  g: any;
  raf: ReturnType<typeof fakeRaf>;
  audio: AudioController;
  /** Every `active` transition AudioController reported, in order -- proves it's event-driven, not polled. */
  audioEvents: boolean[];
} {
  const tracker = new HandleTracker(() => {});
  const raf = fakeRaf();
  const audioEvents: boolean[] = [];
  const audio = new AudioController((active) => audioEvents.push(active));
  const g = {
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    fetch,
    WebSocket,
    requestAnimationFrame: raf.requestAnimationFrame,
    cancelAnimationFrame: raf.cancelAnimationFrame,
    AudioContext: FakeAudioContext,
    HTMLMediaElement: FakeMediaElement,
  };
  installHandleTracking(tracker, g, audio);
  return { tracker, g, raf, audio, audioEvents };
}

test("a timeout is tracked until it fires", async () => {
  const { tracker, g } = sandbox();
  g.setTimeout(() => {}, 5);
  expect(tracker.count).toBe(1);
  await Bun.sleep(30);
  expect(tracker.count).toBe(0);
});

test("an interval is tracked until cleared, and disposeAll stops it", async () => {
  const { tracker, g } = sandbox();
  const id = g.setInterval(() => {}, 1000);
  expect(tracker.count).toBe(1);
  g.clearInterval(id);
  expect(tracker.count).toBe(0);

  const { tracker: tracker2, g: g2 } = sandbox();
  let ticks = 0;
  g2.setInterval(() => ticks++, 5);
  await Bun.sleep(20);
  tracker2.disposeAll();
  const after = ticks;
  await Bun.sleep(20);
  expect(ticks).toBe(after);
  expect(tracker2.count).toBe(0);
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

// Final review, finding H. The wrapper always supplies `init.signal`, and per the Fetch spec an init signal
// overrides a `Request`'s own -- so a signal carried by the Request object was dropped and `abort()` did nothing.
test("a signal carried by a Request aborts the fetch, not just one passed in init", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: async () => {
      await Bun.sleep(5000);
      return new Response("too late");
    },
  });
  try {
    const { tracker, g } = sandbox();
    const controller = new AbortController();
    const request = new Request(`http://localhost:${server.port}/`, { signal: controller.signal });

    const pending = g.fetch(request);
    expect(tracker.count).toBe(1);

    controller.abort();
    await expect(pending).rejects.toThrow();
    // The handle retires with the request, exactly as it does for an init-carried signal.
    expect(tracker.count).toBe(0);
  } finally {
    server.stop(true);
  }
});

test("a WebSocket is tracked from construction until it closes", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: (req, srv) => (srv.upgrade(req) ? undefined : new Response("no upgrade", { status: 400 })),
    websocket: { message: () => {} },
  });
  try {
    const { tracker, g } = sandbox();
    const socket = new g.WebSocket(`ws://127.0.0.1:${server.port}/`);
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

test("a requestAnimationFrame loop is tracked while it keeps rescheduling, and disposeAll cancels a pending frame", () => {
  const { tracker, g, raf } = sandbox();
  let frames = 0;
  const loop = () => {
    frames++;
    if (frames < 3) g.requestAnimationFrame(loop);
  };
  g.requestAnimationFrame(loop);
  expect(tracker.count).toBe(1);
  raf.fire(); // frame 1, reschedules
  expect(tracker.count).toBe(1);
  raf.fire(); // frame 2, reschedules
  expect(tracker.count).toBe(1);
  raf.fire(); // frame 3, does not reschedule: the loop ends on its own
  expect(frames).toBe(3);
  expect(tracker.count).toBe(0);

  g.requestAnimationFrame(() => {
    throw new Error("must not run: disposeAll should have cancelled the frame");
  });
  tracker.disposeAll();
  expect(tracker.count).toBe(0);
  raf.fire();
});

test("an AudioContext is tracked until it closes, and disposeAll closes it (spec section 5.12)", async () => {
  const { tracker, g } = sandbox();
  const ctx = new g.AudioContext();
  expect(tracker.count).toBe(1);
  await ctx.close();
  expect(tracker.count).toBe(0);

  const { tracker: tracker2, g: g2 } = sandbox();
  const ctx2 = new g2.AudioContext();
  tracker2.disposeAll();
  await Bun.sleep(0);
  expect(ctx2.state).toBe("closed");
  expect(tracker2.count).toBe(0);
});

test("a media element is tracked while playing and untracked when it pauses or ends", () => {
  const { tracker, g } = sandbox();
  const el = new g.HTMLMediaElement();
  el.play();
  expect(tracker.count).toBe(1);
  el.pause();
  expect(tracker.count).toBe(0);

  el.play();
  expect(tracker.count).toBe(1);
  el.end();
  expect(tracker.count).toBe(0);
});

// Task 15 (spec §5.12, EX-35): AudioController tracks audio activity separately from HandleTracker's generic
// idle/settled bookkeeping above, and reports only true/false transitions -- never polled.

test("an open AudioContext counts as audio-active, and closing it clears that (spec section 5.12)", async () => {
  const { g, audio, audioEvents } = sandbox();
  expect(audio.active).toBe(false);
  const ctx = new g.AudioContext();
  expect(audio.active).toBe(true);
  expect(audioEvents).toEqual([true]);
  await ctx.close();
  expect(audio.active).toBe(false);
  expect(audioEvents).toEqual([true, false]);
});

test("a playing media element counts as audio-active, and stops counting once it pauses", () => {
  const { g, audio, audioEvents } = sandbox();
  const el = new g.HTMLMediaElement();
  el.play();
  expect(audio.active).toBe(true);
  expect(audioEvents).toEqual([true]);
  el.pause();
  expect(audio.active).toBe(false);
  expect(audioEvents).toEqual([true, false]);
});

test("muting zeroes a tracked AudioContext's destination gain without closing or suspending it", async () => {
  const { g, audio } = sandbox();
  const ctx = new g.AudioContext();
  // `destination` is shadowed with the inserted gain node the moment the context is constructed (this is what
  // makes muting possible without suspending: there is no public way to zero AudioDestinationNode itself).
  expect(ctx.destination.gain.value).toBe(1);
  audio.setMuted(true);
  expect(ctx.destination.gain.value).toBe(0);
  // Never suspended or closed: a suspended AudioContext stops its own clock, which would desync anything a run
  // times off it (a rAF-driven visualisation, a scheduler) -- this is the distinction the task turns on.
  expect(ctx.state).toBe("running");
  audio.setMuted(false);
  expect(ctx.destination.gain.value).toBe(1);
  expect(ctx.state).toBe("running");
});

test("muting pauses playing media immediately, and media started while already muted is paused right away too", () => {
  const { g, audio } = sandbox();
  const el = new g.HTMLMediaElement();
  el.play();
  expect(el.paused).toBe(false);
  audio.setMuted(true);
  expect(el.paused).toBe(true);

  // A second element that starts playing after mute was already toggled on must not audibly play either.
  const el2 = new g.HTMLMediaElement();
  el2.play();
  expect(el2.paused).toBe(true);
});

// Fix round 1, M1: autoplay policy starts a gesture-less AudioContext "suspended", not "running" -- the common
// case, not the rare one -- so audio-active tracking must follow `state`, not just construction/close.
test("a suspended AudioContext does not count as audio-active until it resumes (fix round 1, M1)", async () => {
  const { g, audio, audioEvents } = sandbox();
  const ctx = new g.AudioContext(true); // constructed suspended, as autoplay policy would leave it
  expect(audio.active).toBe(false);
  expect(audioEvents).toEqual([]);

  await ctx.resume();
  expect(audio.active).toBe(true);
  expect(audioEvents).toEqual([true]);

  await ctx.suspend();
  expect(audio.active).toBe(false);
  expect(audioEvents).toEqual([true, false]);

  // Closing while suspended must not double-report (it was already reported inactive above).
  await ctx.close();
  expect(audioEvents).toEqual([true, false]);
});

// Fix round 1, M2 (the most user-visible finding): a rejected play() -- exactly what a browser does until the
// user has interacted with the page -- must not leave the tab claiming to make noise forever.
test("a rejected play() releases the handle instead of leaving the indicator stuck on (fix round 1, M2)", async () => {
  const { tracker, g, audio } = sandbox();
  const el = new g.HTMLMediaElement();
  el.rejectNextPlay = true;
  el.play().catch(() => {}); // the run's own code would ordinarily handle or ignore this too
  expect(tracker.count).toBe(1); // registered optimistically, before the promise settles
  await Bun.sleep(0); // let the rejection settle and handles.ts's own .catch() run
  expect(tracker.count).toBe(0);
  expect(audio.active).toBe(false);
});

// Task 9d: fix round 1 (M2) closed the *rejected promise* path above, but `play.apply(this, args)` itself was
// still unguarded -- so a synchronous throw left `tracker.add(this, ...)` registered and the run never reached
// idle. Half of the finding was fixed and the other half never re-checked.
test("a synchronously thrown play() releases the handle instead of leaking it", () => {
  const { tracker, g, audio, audioEvents } = sandbox();
  const el = new g.HTMLMediaElement();
  el.throwNextPlay = true;
  expect(() => el.play()).toThrow("InvalidStateError");
  expect(tracker.count).toBe(0);
  expect(audio.active).toBe(false);
  expect(audioEvents).toEqual([]);
});

// Fix round 1, M3: a play attempt while already muted must not audibly play, but registering it as active and
// then immediately pausing it back down emits a spurious true-then-false `audio` message pair for a play that
// was never actually going to be heard.
test("a play attempt while already muted emits no audio message at all (fix round 1, M3)", () => {
  const { g, audio, audioEvents } = sandbox();
  audio.setMuted(true);
  const el = new g.HTMLMediaElement();
  el.play();
  expect(el.paused).toBe(true);
  expect(audio.active).toBe(false);
  expect(audioEvents).toEqual([]);
});

/**
 * A timer pair whose ids are small integers from their own counter, exactly as a browser's are.
 *
 * `sandbox()` above hands the wrappers Bun's real `setTimeout`, which returns a `Timer` **object**. An object key
 * and `fakeRaf`'s numeric key can never collide, so the id-space collision below is unreachable through that
 * fixture by construction -- which is why it went unnoticed. Per the HTML spec `setTimeout`/`setInterval` share one
 * id space and `requestAnimationFrame` has its own, and both start at 1, so a timer and a frame genuinely do
 * collide on a raw-id key.
 */
function fakeTimers() {
  let nextId = 1;
  const callbacks = new Map<number, () => void>();
  return {
    setTimeout: (cb: () => void, _ms?: number) => {
      const id = nextId++;
      callbacks.set(id, cb);
      return id;
    },
    clearTimeout: (id: number) => void callbacks.delete(id),
    setInterval: (cb: () => void, _ms?: number) => {
      const id = nextId++;
      callbacks.set(id, cb);
      return id;
    },
    clearInterval: (id: number) => void callbacks.delete(id),
    fire: () => {
      const due = [...callbacks];
      callbacks.clear();
      for (const [, cb] of due) cb();
    },
    pending: () => callbacks.size,
  };
}

/** `sandbox()`, but with browser-shaped **numeric** timer ids, so timer and rAF id spaces can actually collide. */
function numericSandbox() {
  const tracker = new HandleTracker(() => {});
  const raf = fakeRaf();
  const timers = fakeTimers();
  const audio = new AudioController(() => {});
  const g = {
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
    requestAnimationFrame: raf.requestAnimationFrame,
    cancelAnimationFrame: raf.cancelAnimationFrame,
    // biome-ignore lint/suspicious/noExplicitAny: sandboxed global object
  } as any;
  installHandleTracking(tracker, g, audio);
  return { tracker, g, raf, timers };
}

// Final review, finding A. `HandleTracker` keys one Map by the raw platform id, but timer ids and rAF ids come from
// two different id spaces that both start at 1. The second `add()` for the colliding key was silently dropped, so
// the rAF loop was never tracked: the run reported `idle` while still animating, and Stop called `clearTimeout` on
// what was really a frame id, leaving the animation running against a page the host believed was finished.
test("a timer and a requestAnimationFrame loop with the same raw id are tracked as two separate handles", () => {
  const { tracker, g } = numericSandbox();

  const timerId = g.setTimeout(() => {}, 10_000);
  const frameId = g.requestAnimationFrame(() => {});

  // The collision this test exists for: both id spaces start at 1, so these really are equal.
  expect(timerId).toBe(1);
  expect(frameId).toBe(1);
  expect(tracker.count).toBe(2);
});

test("Stop cancels a rAF loop that shares its raw id with a live timer", () => {
  const { tracker, g, raf } = numericSandbox();

  g.setTimeout(() => {}, 10_000); // timer id 1
  let frames = 0;
  const loop = () => {
    frames++;
    g.requestAnimationFrame(loop); // frame id 1 -- collides with the timeout above
  };
  g.requestAnimationFrame(loop);
  expect(tracker.count).toBe(2);

  raf.fire();
  expect(frames).toBe(1); // the loop is running and has rescheduled itself

  tracker.disposeAll(); // Stop
  expect(tracker.count).toBe(0);
  raf.fire();
  // The frame must have been cancelled by `cancelAnimationFrame`, not left running because Stop disposed the
  // timer that shared its id.
  expect(frames).toBe(1);
});

test("clearing a timer leaves a rAF loop with the same raw id tracked and still running", () => {
  const { tracker, g, raf } = numericSandbox();

  const timerId = g.setTimeout(() => {}, 10_000);
  let frames = 0;
  const loop = () => {
    frames++;
    g.requestAnimationFrame(loop);
  };
  g.requestAnimationFrame(loop);

  g.clearTimeout(timerId);
  // Only the timer retires: the frame loop is still active, so the run is NOT idle.
  expect(tracker.count).toBe(1);

  raf.fire();
  expect(frames).toBe(1);
});

/**
 * The user-reported M4 defect ("the interface items that track the auto-run are stuck on a re-render loop"): the
 * activity-bar spinner, the Stop button and the run-state text all flickering on a `browser` tab.
 *
 * Every sandbox above constructs `new HandleTracker(() => {})` -- it throws the notifications away and asserts only
 * `tracker.count` *at rest*. That is precisely why this went unseen: at rest the count really is 1 and everything
 * above passes. The defect lives entirely in the transitions emitted *between* two resting points.
 *
 * This fixture is `bootstrap.ts`'s own tracker wiring, verbatim:
 *
 *     const tracker = new HandleTracker((count) => {
 *       if (!run) return;
 *       const action = handleCountAction(run.state, false, count);
 *       if (action === "dispose") tracker.disposeAll();
 *       else if (action) setState(action);
 *     });
 *
 * and `setState` assigns `run.state` and then sends one `state` message to the host. So `states` below is exactly
 * the sequence of `state` messages a real page would put on the wire, which is what the UI re-renders from.
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
  const raf = fakeRaf();
  const timers = fakeTimers();
  const audio = new AudioController(() => {});
  const g = {
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
    requestAnimationFrame: raf.requestAnimationFrame,
    cancelAnimationFrame: raf.cancelAnimationFrame,
    // biome-ignore lint/suspicious/noExplicitAny: sandboxed global object
  } as any;
  installHandleTracking(tracker, g, audio);
  return { states, run, tracker, raf, timers, g };
}

// The loop itself. A run that ended `settled` with one frame pending -- any ordinary animation -- used to emit an
// `idle` and a `settled` on EVERY frame, because the wrapper retired the frame before running the callback that
// reschedules it, dipping the count 1 -> 0 -> 1. `settled` is in the UI's BUSY_STATES and `idle` is not, so `busy`
// flipped 120 times a second and remounted the spinner (restarting its CSS animation) with it.
test("a self-rescheduling rAF loop emits no state messages at all while it keeps looping", () => {
  const { states, tracker, raf, g } = stateRecordingSandbox("settled");
  const loop = () => {
    g.requestAnimationFrame(loop);
  };
  g.requestAnimationFrame(loop);
  states.length = 0;

  for (let frame = 0; frame < 5; frame += 1) raf.fire();

  // Asserting the exact sequence, not "contains no idle" or "the last one is settled": the whole defect is extra
  // transitions, so a superset assertion would accept the broken state (five idle/settled pairs) as a pass.
  expect(states).toEqual([]);
  expect(tracker.count).toBe(1);
});

test("a self-rescheduling setTimeout chain emits no state messages at all while it keeps looping", () => {
  const { states, tracker, timers, g } = stateRecordingSandbox("settled");
  const tick = () => {
    g.setTimeout(tick, 16);
  };
  g.setTimeout(tick, 16);
  states.length = 0;

  for (let round = 0; round < 5; round += 1) timers.fire();

  expect(states).toEqual([]);
  expect(tracker.count).toBe(1);
});

// The other half: holding the notification for the callback's duration must not SUPPRESS the real transition. A
// loop that stops rescheduling has genuinely gone idle on that tick, and must say so -- exactly once.
test("a rAF loop that stops rescheduling still reports idle, exactly once", () => {
  const { states, tracker, raf, g } = stateRecordingSandbox("settled");
  let frames = 0;
  const loop = () => {
    frames += 1;
    if (frames < 3) g.requestAnimationFrame(loop);
  };
  g.requestAnimationFrame(loop);
  states.length = 0;

  raf.fire(); // reschedules
  raf.fire(); // reschedules
  raf.fire(); // does not reschedule: the run is genuinely idle now

  expect(frames).toBe(3);
  expect(states).toEqual(["idle"]);
  expect(tracker.count).toBe(0);
});

test("a one-shot setTimeout still reports idle, exactly once", () => {
  const { states, tracker, timers, g } = stateRecordingSandbox("settled");
  g.setTimeout(() => {}, 16);
  states.length = 0;

  timers.fire();

  expect(states).toEqual(["idle"]);
  expect(tracker.count).toBe(0);
});

test("handleCountAction disposes new handles after a stop, and tracks idle/settled otherwise", () => {
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
