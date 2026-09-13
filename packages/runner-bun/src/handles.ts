// biome-ignore-all lint/suspicious/noExplicitAny: wrapping untyped host APIs
type AnyFn = (...args: any[]) => any;

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
