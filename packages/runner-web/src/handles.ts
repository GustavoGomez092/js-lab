// biome-ignore-all lint/suspicious/noExplicitAny: wrapping untyped host APIs
import type { RunnerState } from "@jslab/rpc-schema";

type AnyFn = (...args: any[]) => any;

/** What the runner does when its tracked-handle count changes (FW1: mirrors the Bun runner's rule verbatim). */
export function handleCountAction(
  state: RunnerState,
  exiting: boolean,
  count: number,
): "dispose" | "idle" | "settled" | null {
  if ((state === "stopped" || exiting) && count > 0) return "dispose";
  if (state === "settled" && count === 0) return "idle";
  if (state === "idle" && count > 0) return "settled";
  return null;
}

/** Tracks handles that keep a run "active" (timers, rAF loops, AudioContexts, media elements, sockets, requests). */
export class HandleTracker {
  readonly #active = new Map<unknown, () => void>();
  #batchDepth = 0;
  #batchEntryCount = 0;

  constructor(private readonly onChange: (count: number) => void) {}

  get count(): number {
    return this.#active.size;
  }

  #notify(): void {
    if (this.#batchDepth > 0) return;
    this.onChange(this.#active.size);
  }

  /**
   * Runs `body` as ONE atomic change to the handle set: `onChange` is held for its synchronous duration and then
   * fired at most once, and only if the count actually ended up different from what it was on entry.
   *
   * This exists because a firing timer or frame is not two independent events. The wrappers below retire a handle
   * and then invoke the user's callback, and a *self-rescheduling* callback (`setTimeout(tick)` that calls
   * `setTimeout(tick)` again, the standard rAF loop) registers its successor inside that callback. Without this,
   * the count visibly dips 1 -> 0 -> 1 on every single tick, and `handleCountAction`'s two exactly inverse rules
   * (`settled && count === 0 -> "idle"`, `idle && count > 0 -> "settled"`) turn each dip into an `idle` state
   * message immediately followed by a `settled` one. At 60 fps that is 120 state messages a second, and because
   * the UI's `BUSY_STATES` contains `settled` but not `idle`, its `busy` flag flips with every one of them --
   * remounting the activity-bar spinner (restarting its CSS animation, so it "reloads instead of animating"),
   * swapping the Stop button for the Run button and back, and rewriting the status text, ~60 times a second.
   *
   * Holding the notification is not a debounce and hides nothing: the scope is lexically bound to the callback's
   * own synchronous execution, not to a timeout, and the single notification it ends with reports the true count.
   * A loop that stops rescheduling still drops to 0 and still reports `idle` on that very tick.
   *
   * The retire-then-run order is deliberately preserved rather than inverted to retire *after* the callback. The
   * platform is free to reuse a fired timer's id for a timer created inside that callback, and `HandleKeys` below
   * early-returns for an id it already holds -- so retiring afterwards would silently leave the successor of a
   * self-rescheduling loop untracked, and the run would report `idle` while still animating. That is the exact
   * failure `HandleKeys`' own doc comment was written for.
   */
  batch<T>(body: () => T): T {
    if (this.#batchDepth === 0) this.#batchEntryCount = this.#active.size;
    this.#batchDepth += 1;
    try {
      return body();
    } finally {
      this.#batchDepth -= 1;
      if (this.#batchDepth === 0 && this.#active.size !== this.#batchEntryCount) this.onChange(this.#active.size);
    }
  }

  add(key: unknown, dispose: () => void): void {
    if (this.#active.has(key)) return;
    this.#active.set(key, dispose);
    this.#notify();
  }

  remove(key: unknown): void {
    if (this.#active.delete(key)) this.#notify();
  }

  disposeAll(): void {
    const disposers = [...this.#active.values()];
    this.#active.clear();
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {}
    }
    this.#notify();
  }
}

/**
 * Maps one kind of handle's raw platform ids onto unique object keys for `HandleTracker`.
 *
 * `HandleTracker` keys a single Map by whatever it is handed, so the raw id a platform API returned cannot be that
 * key: per the HTML spec `setTimeout`/`setInterval` share one id space while `requestAnimationFrame` has its own,
 * and **both start at 1**. A timer and a frame therefore collide -- `add()` early-returns for the second one, so it
 * is never tracked and no disposer is ever stored for it, and `remove()` deletes whichever of the two it finds.
 * The observable failure was a run with a `setTimeout` and a rAF loop reporting `idle` while still animating, and
 * Stop calling `clearTimeout` on what was really a frame id, leaving the animation running against a page the host
 * believed had finished.
 *
 * Giving each kind its own registry makes two kinds structurally unable to share a key -- the same collision-proofing
 * `fetch`, `AudioContext` and media elements already get from minting an object key of their own.
 */
class HandleKeys {
  readonly #keys = new Map<unknown, object>();

  constructor(private readonly tracker: HandleTracker) {}

  add(rawId: unknown, dispose: () => void): void {
    if (this.#keys.has(rawId)) return;
    const key = {};
    this.#keys.set(rawId, key);
    // The disposer clears this map too, so `disposeAll()` (Stop) leaves no stale id behind for a later
    // `clearTimeout`/`cancelAnimationFrame` of a since-reused id to match against.
    this.tracker.add(key, () => {
      this.#keys.delete(rawId);
      dispose();
    });
  }

  remove(rawId: unknown): void {
    const key = this.#keys.get(rawId);
    if (key === undefined) return;
    this.#keys.delete(rawId);
    this.tracker.remove(key);
  }
}

/** What `AudioController` needs from a `GainNode`'s `.gain` `AudioParam`: a settable `.value`. */
export interface GainLike {
  value: number;
}

/** What `AudioController` needs from a playing media element: a way to stop it. */
export interface Pausable {
  pause(): void;
}

/**
 * Tracks audio activity (spec §5.12, parity EX-35: "while an AudioContext is running or a media element is
 * playing, the tab shows a speaker icon") and implements mute -- separately from `HandleTracker`'s generic
 * idle/settled bookkeeping above, since the tab icon cares specifically about *audio* handles, not timers or
 * sockets. `onActiveChange` fires only on an inactive↔active transition, so the host is told by an event, never
 * by polling.
 *
 * Muting zeroes every tracked AudioContext's inserted gain node and pauses every tracked playing media element --
 * it never suspends a context. Suspending stops that context's own clock (`currentTime` stops advancing), which
 * would desync anything a run times off it (a rAF-driven visualisation, a scheduler); zeroing gain keeps the clock
 * running while silencing the output. There is no public way to zero `AudioDestinationNode` itself, which is why
 * `installHandleTracking` below inserts a `GainNode` between a context's graph and its real destination and
 * shadows `destination` to return that node instead (every connection to `destination` is rerouted through it).
 */
export class AudioController {
  readonly #contexts = new Set<GainLike>();
  readonly #playing = new Set<Pausable>();
  #muted = false;

  constructor(private readonly onActiveChange: (active: boolean) => void) {}

  get active(): boolean {
    return this.#contexts.size > 0 || this.#playing.size > 0;
  }

  get muted(): boolean {
    return this.#muted;
  }

  #notify(wasActive: boolean): void {
    if (this.active !== wasActive) this.onActiveChange(this.active);
  }

  /** Registers a context's inserted gain node, applying the current mute state to it immediately. */
  addContext(gain: GainLike): void {
    const was = this.active;
    this.#contexts.add(gain);
    gain.value = this.#muted ? 0 : 1;
    this.#notify(was);
  }

  removeContext(gain: GainLike): void {
    const was = this.active;
    if (this.#contexts.delete(gain)) this.#notify(was);
  }

  addPlaying(element: Pausable): void {
    const was = this.active;
    this.#playing.add(element);
    this.#notify(was);
  }

  removePlaying(element: Pausable): void {
    const was = this.active;
    if (this.#playing.delete(element)) this.#notify(was);
  }

  /**
   * Toggles mute for the page's whole lifetime (not just the current run). A no-op when the state doesn't
   * actually change, so it's safe to call from, for example, every "run" message re-asserting the tab's saved
   * preference. Unmuting does not resume media this paused -- only the user (or the run) restarting it does.
   */
  setMuted(muted: boolean): void {
    if (this.#muted === muted) return;
    this.#muted = muted;
    for (const gain of this.#contexts) gain.value = muted ? 0 : 1;
    if (muted) for (const element of [...this.#playing]) element.pause();
  }
}

/**
 * Web handle tracking (spec §5.6, §5.12): timers, `requestAnimationFrame` loops, `AudioContext`, media elements,
 * `WebSocket` and `fetch` aborts. Unlike the Bun runner, there are no servers or child processes to track.
 */
export function installHandleTracking(tracker: HandleTracker, g: any = globalThis, audio: AudioController): void {
  const {
    setTimeout: st,
    clearTimeout: ct,
    setInterval: si,
    clearInterval: ci,
    fetch: f,
    WebSocket: NativeWebSocket,
    requestAnimationFrame: raf,
    cancelAnimationFrame: caf,
    AudioContext: NativeAudioContext,
    HTMLMediaElement,
  } = g;

  // One registry per id space (see `HandleKeys`): timers share theirs, exactly as the platform does, while frames
  // below get their own -- so a timer id and a frame id that are both `1` can never collide on one tracker key.
  const timerKeys = new HandleKeys(tracker);
  const frameKeys = new HandleKeys(tracker);

  g.setTimeout = Object.assign((fn: AnyFn, ms?: number, ...args: unknown[]) => {
    const id = st(
      (...a: unknown[]) => {
        // Retiring this timer and running its callback are one atomic change to the handle set (`batch`'s own doc
        // comment): a `setTimeout` chain that reschedules itself here must not dip the count to 0 in between and
        // emit a spurious `idle`/`settled` pair on every single tick.
        tracker.batch(() => {
          timerKeys.remove(id);
          fn(...a);
        });
      },
      ms,
      ...args,
    );
    timerKeys.add(id, () => ct(id));
    return id;
  }, st);
  g.clearTimeout = (id?: unknown) => {
    timerKeys.remove(id);
    ct(id);
  };

  g.setInterval = Object.assign((fn: AnyFn, ms?: number, ...args: unknown[]) => {
    const id = si(fn, ms, ...args);
    timerKeys.add(id, () => ci(id));
    return id;
  }, si);
  g.clearInterval = (id?: unknown) => {
    timerKeys.remove(id);
    ci(id);
  };

  if (typeof f === "function") {
    g.fetch = Object.assign((input: unknown, init?: RequestInit) => {
      const controller = new AbortController();
      // Per the Fetch spec `new Request(input, init)` takes `init["signal"]` whenever it is present, and this
      // wrapper always supplies one -- so a signal carried by a `Request` passed as `input` was overridden and
      // silently stopped working: `fetch(new Request(url, { signal }))` then `abort()` cancelled nothing, in both
      // web runtimes. Every caller-supplied signal is merged with this wrapper's own instead of only `init`'s.
      const callerSignals: AbortSignal[] = [];
      if (init?.signal) callerSignals.push(init.signal);
      if (typeof Request === "function" && input instanceof Request && input.signal) callerSignals.push(input.signal);
      const signal =
        callerSignals.length > 0 ? AbortSignal.any([...callerSignals, controller.signal]) : controller.signal;
      const key = {};
      tracker.add(key, () => controller.abort());
      return f(input, { ...init, signal }).finally(() => tracker.remove(key));
    }, f);
  }

  // Spec §5.6: a WebSocket is active from construction until it closes or errors; disposing closes it. A subclass
  // keeps `instanceof WebSocket`, the static readyState constants and `new` semantics intact.
  if (typeof NativeWebSocket === "function") {
    g.WebSocket = class WebSocket extends (NativeWebSocket as new (...args: any[]) => any) {
      constructor(...args: any[]) {
        super(...args);
        const release = () => tracker.remove(this);
        this.addEventListener("close", release);
        this.addEventListener("error", release);
        tracker.add(this, () => this.close());
      }
    };
  }

  // A rAF *loop* (not a single frame) is active only while it keeps rescheduling: the same one-shot-then-rechain
  // pattern as the timer wrappers above, applied to frames instead of ticks.
  if (typeof raf === "function" && typeof caf === "function") {
    g.requestAnimationFrame = Object.assign((fn: (time: number) => void) => {
      const id = raf((time: number) => {
        // The rAF loop is the case the user actually hit: see `batch`'s doc comment. Retiring this frame and
        // running its callback (which reschedules the next one) is one atomic change, not two.
        tracker.batch(() => {
          frameKeys.remove(id);
          fn(time);
        });
      });
      frameKeys.add(id, () => caf(id));
      return id;
    }, raf);
    g.cancelAnimationFrame = (id?: unknown) => {
      frameKeys.remove(id);
      caf(id);
    };
  }

  // Spec §5.12: an AudioContext is active from construction until it closes; Stop closes it.
  if (typeof NativeAudioContext === "function") {
    g.AudioContext = class AudioContext extends (NativeAudioContext as new (...args: any[]) => any) {
      constructor(...args: any[]) {
        super(...args);
        tracker.add(this, () => {
          this.close().catch(() => {});
        });
        // Task 15: capture the real destination before shadowing it, insert a gain node between the two, and
        // route every future `context.destination` read through that node instead -- see AudioController's own
        // doc comment above for why this (rather than suspending) is how mute works.
        const realDestination = this.destination;
        const gain = this.createGain();
        gain.connect(realDestination);
        Object.defineProperty(this, "destination", { value: gain, configurable: true, enumerable: false });
        // Fix round 1, M1: a context created without a user gesture starts "suspended" under autoplay policy --
        // the common case, not the rare one -- and the spec calls for the icon on a *running* context, so
        // audio-active tracking follows `state` rather than construction/close alone: register only while
        // actually "running", and follow every later suspend/resume too.
        if (this.state === "running") audio.addContext(gain.gain);
        this.addEventListener("statechange", () => {
          if (this.state === "closed") {
            tracker.remove(this);
            audio.removeContext(gain.gain);
          } else if (this.state === "suspended") {
            audio.removeContext(gain.gain);
          } else if (this.state === "running") {
            audio.addContext(gain.gain);
          }
        });
      }
    };
  }

  // A media element (<audio>/<video>) is active while playing, regardless of how it was constructed
  // (`document.createElement`, `new Audio()`, ...): the prototype method is wrapped rather than the constructor.
  if (HTMLMediaElement?.prototype && typeof HTMLMediaElement.prototype.play === "function") {
    const play: AnyFn = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (this: any, ...args: unknown[]) {
      tracker.add(this, () => this.pause());
      const release = () => {
        tracker.remove(this);
        audio.removePlaying(this);
      };
      this.addEventListener("pause", release, { once: true });
      this.addEventListener("ended", release, { once: true });
      // Task 9d: `play()` can also fail *synchronously* (an InvalidStateError, say). The rejected-promise path
      // below was already handled, but a synchronous throw skipped it entirely, leaving the handle registered and
      // the audio indicator stuck on, so the run never reached idle.
      let result: any;
      try {
        result = play.apply(this, args);
      } catch (error) {
        release();
        throw error;
      }
      // Task 15: mute is a persistent state, not a one-shot action -- media that starts playing while the tab is
      // already muted must not audibly play either. Fix round 1, M3: checking `audio.muted` *before* registering
      // with AudioController (rather than registering then immediately pausing) avoids emitting a spurious
      // true-then-false `audio` message pair for a play that was never actually going to be heard.
      if (audio.muted) this.pause();
      else audio.addPlaying(this);
      // Fix round 1, M2: a rejected play() -- exactly what a browser does until the user has interacted with
      // the page -- fires neither "pause" nor "ended", so without this the handle (and the audio-active state
      // with it) would stay registered for the page's lifetime with nothing actually playing. Attaching this
      // handler also marks the promise "handled" for unhandled-rejection purposes, the same accepted divergence
      // `bootstrap.ts`'s own `watchPromise` already documents for the analogous case.
      if (result && typeof result.then === "function") result.catch(() => release());
      return result;
    };
  }
}
