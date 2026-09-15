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

  g.setImmediate = Object.assign((fn: AnyFn, ...args: unknown[]) => {
    const id = sim(
      (...a: unknown[]) => {
        tracker.remove(id);
        fn(...a);
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
