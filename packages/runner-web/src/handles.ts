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

  constructor(private readonly onChange: (count: number) => void) {}

  get count(): number {
    return this.#active.size;
  }

  add(key: unknown, dispose: () => void): void {
    if (this.#active.has(key)) return;
    this.#active.set(key, dispose);
    this.onChange(this.#active.size);
  }

  remove(key: unknown): void {
    if (this.#active.delete(key)) this.onChange(this.#active.size);
  }

  disposeAll(): void {
    const disposers = [...this.#active.values()];
    this.#active.clear();
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {}
    }
    this.onChange(0);
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

  g.setTimeout = Object.assign((fn: AnyFn, ms?: number, ...args: unknown[]) => {
    const id = st(
      (...a: unknown[]) => {
        tracker.remove(id);
        fn(...a);
      },
      ms,
      ...args,
    );
    tracker.add(id, () => ct(id));
    return id;
  }, st);
  g.clearTimeout = (id?: unknown) => {
    tracker.remove(id);
    ct(id);
  };

  g.setInterval = Object.assign((fn: AnyFn, ms?: number, ...args: unknown[]) => {
    const id = si(fn, ms, ...args);
    tracker.add(id, () => ci(id));
    return id;
  }, si);
  g.clearInterval = (id?: unknown) => {
    tracker.remove(id);
    ci(id);
  };

  if (typeof f === "function") {
    g.fetch = Object.assign((input: unknown, init?: RequestInit) => {
      const controller = new AbortController();
      const signal = init?.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
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
        tracker.remove(id);
        fn(time);
      });
      tracker.add(id, () => caf(id));
      return id;
    }, raf);
    g.cancelAnimationFrame = (id?: unknown) => {
      tracker.remove(id);
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
