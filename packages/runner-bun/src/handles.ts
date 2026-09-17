// biome-ignore-all lint/suspicious/noExplicitAny: wrapping untyped host APIs
import type { RunnerState } from "@jslab/rpc-schema";

type AnyFn = (...args: any[]) => any;

/** What the runner does when its tracked-handle count changes (FW1: a caught process.exit disposes new handles at once). */
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

/** Tracks handles that keep a run "active" (timers, servers, sockets, requests, child processes). */
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
   * This exists because a firing timer is not two independent events. The wrappers below retire a handle and then
   * invoke the user's callback, and a *self-rescheduling* callback (`setTimeout(tick)` that calls `setTimeout(tick)`
   * again, the same shape with `setImmediate`) registers its successor inside that callback. Without this, the count
   * visibly dips 1 -> 0 -> 1 on every single tick, and `handleCountAction`'s two exactly inverse rules (`settled &&
   * count === 0 -> "idle"`, `idle && count > 0 -> "settled"`) turn each dip into an `idle` state message immediately
   * followed by a `settled` one. `bootstrap.ts` sends one `state` message per transition, so a 16 ms chain puts 120
   * of them a second on the IPC channel, and because the UI's `BUSY_STATES` contains `settled` but not `idle`, its
   * `busy` flag flips with every one of them -- remounting the activity-bar spinner (restarting its CSS animation,
   * so it "reloads instead of animating"), swapping the Stop button for the Run button and back, and rewriting the
   * status text, ~60 times a second.
   *
   * Holding the notification is not a debounce and hides nothing: the scope is lexically bound to the callback's
   * own synchronous execution, not to a timeout, and the single notification it ends with reports the true count.
   * A loop that stops rescheduling still drops to 0 and still reports `idle` on that very tick.
   *
   * The retire-then-run order is deliberately preserved rather than inverted to retire *after* the callback. The
   * platform is free to reuse a fired timer's id for a timer created inside that callback, and `add` above
   * early-returns for a key it already holds -- so retiring afterwards would silently leave the successor of a
   * self-rescheduling loop untracked, and the run would report `idle` while it is still ticking.
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

export function installHandleTracking(tracker: HandleTracker, g: any = globalThis): void {
  const {
    setTimeout: st,
    clearTimeout: ct,
    setInterval: si,
    clearInterval: ci,
    setImmediate: sim,
    clearImmediate: cim,
    fetch: f,
  } = g;

  g.setTimeout = Object.assign((fn: AnyFn, ms?: number, ...args: unknown[]) => {
    const id = st(
      (...a: unknown[]) => {
        // Retiring this timer and running its callback are one atomic change to the handle set (`batch`'s own doc
        // comment): a `setTimeout` chain that reschedules itself here must not dip the count to 0 in between and
        // emit a spurious `idle`/`settled` pair on every single tick.
        tracker.batch(() => {
          tracker.remove(id);
          fn(...a);
        });
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

  g.setImmediate = Object.assign((fn: AnyFn, ...args: unknown[]) => {
    const id = sim(
      (...a: unknown[]) => {
        // Same atomic change as the `setTimeout` wrapper above: a `setImmediate` callback that re-arms itself is
        // the other self-rescheduling shape available in the Bun runtime, and dipped the count identically.
        tracker.batch(() => {
          tracker.remove(id);
          fn(...a);
        });
      },
      ...args,
    );
    tracker.add(id, () => cim(id));
    return id;
  }, sim);
  g.clearImmediate = (id?: unknown) => {
    tracker.remove(id);
    cim(id);
  };

  g.fetch = Object.assign((input: unknown, init?: RequestInit) => {
    const controller = new AbortController();
    const signal = init?.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
    const key = {};
    tracker.add(key, () => controller.abort());
    return f(input, { ...init, signal }).finally(() => tracker.remove(key));
  }, f);

  // Spec §5.6: a WebSocket is active from construction until it closes or errors; disposing closes it. A subclass
  // keeps `instanceof WebSocket`, the static readyState constants and `new` semantics intact.
  if (typeof g.WebSocket === "function") {
    const NativeWebSocket: new (...args: any[]) => WebSocket = g.WebSocket;
    g.WebSocket = class WebSocket extends NativeWebSocket {
      constructor(...args: any[]) {
        super(...args);
        const release = () => tracker.remove(this);
        this.addEventListener("close", release);
        this.addEventListener("error", release);
        tracker.add(this, () => this.close());
      }
    };
  }

  for (const name of ["node:http", "node:https", "node:net"]) {
    try {
      const mod = require(name);
      const original: AnyFn = mod.createServer;
      mod.createServer = (...args: unknown[]) => {
        const server = original(...args);
        server.on("listening", () => tracker.add(server, () => server.close()));
        server.on("close", () => tracker.remove(server));
        return server;
      };
    } catch {}
  }

  try {
    const cp = require("node:child_process");
    for (const method of ["spawn", "exec", "execFile", "fork"]) {
      const original: AnyFn = cp[method];
      cp[method] = (...args: unknown[]) => {
        const child = original(...args);
        tracker.add(child, () => child.kill());
        child.once("exit", () => tracker.remove(child));
        child.once("close", () => tracker.remove(child));
        return child;
      };
    }
  } catch {}

  try {
    const serve: AnyFn = g.Bun.serve;
    Object.defineProperty(g.Bun, "serve", {
      configurable: true,
      writable: true,
      value: (options: unknown) => {
        const server = serve(options);
        const stop = server.stop.bind(server);
        tracker.add(server, () => stop(true));
        try {
          server.stop = (force?: boolean) => {
            tracker.remove(server);
            return stop(force);
          };
        } catch {}
        return server;
      },
    });
  } catch {}
}
