import { expect, test } from "bun:test";
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
  state: "running" | "closed" = "running";
  /** The real destination `handles.ts` reads *before* it shadows `this.destination` with the inserted gain node. */
  destination = { kind: "real-destination" as const };
  #listeners = new Map<string, Set<() => void>>();
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
  async close(): Promise<void> {
    if (this.state === "closed") return;
    this.state = "closed";
    this.#emit("statechange");
  }
}

class FakeMediaElement {
  paused = true;
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
