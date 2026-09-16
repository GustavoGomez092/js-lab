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

/**
 * Web handle tracking (spec §5.6, §5.12): timers, `requestAnimationFrame` loops, `AudioContext`, media elements,
 * `WebSocket` and `fetch` aborts. Unlike the Bun runner, there are no servers or child processes to track.
 */
export function installHandleTracking(tracker: HandleTracker, g: any = globalThis): void {
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
        this.addEventListener("statechange", () => {
          if (this.state === "closed") tracker.remove(this);
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
      const release = () => tracker.remove(this);
      this.addEventListener("pause", release, { once: true });
      this.addEventListener("ended", release, { once: true });
      return play.apply(this, args);
    };
  }
}
