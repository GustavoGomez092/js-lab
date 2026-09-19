import { expect, test } from "bun:test";
import type { WebToHostMessage } from "@jslab/rpc-schema";
import { type RunnerWebGlobal, startRunnerWeb } from "../src/bootstrap";

/**
 * A trivial `browser`-runtime run -- no async, no handles of any kind -- MUST finish `idle` with zero active
 * handles.
 *
 * The user-reported defect this pins: on a `browser` tab with Auto Run on, `const test: string = "test"` left the
 * status bar reading "Running: 1 active handle" indefinitely. `bootstrap.ts`'s terminal state is
 * `tracker.count > 0 ? "settled" : "idle"` and `apps/ui/src/shell/labels.ts` puts `settled` in `BUSY_STATES`, so a
 * single stray tracked handle is indistinguishable from a run that never finished.
 *
 * `run-completion.test.ts` already asserts `idle` for an ordinary run, but through a global that has only timers:
 * `installHandleTracking` then installs *none* of its other wrappers, so nothing that file does could ever catch a
 * handle leaked by the rAF / WebSocket / AudioContext / media paths. This global is page-shaped -- every API a real
 * webview offers is present, so every wrapper really installs.
 *
 * The `calls` log is deliberately installed **after** `startRunnerWeb` returns, on top of the wrappers
 * `installHandleTracking` left on the global. That is what makes it meaningful: the bootstrap's own heartbeat and
 * `EventBuffer` flush timer were captured from the raw globals *before* those wrappers existed
 * (`bootstrap.ts`'s `timers`/`rawInterval`), so they are invisible here -- exactly as they are invisible to the
 * tracker. Anything this log records is therefore a *tracked* handle the run itself created.
 */

class FakeGainNode {
  gain = { value: 1 };
  connect(_destination: unknown): void {}
}

class FakeAudioContext {
  state: "running" | "suspended" | "closed" = "running";
  destination = { kind: "real-destination" as const };
  addEventListener(_type: string, _cb: () => void): void {}
  createGain(): FakeGainNode {
    return new FakeGainNode();
  }
  async close(): Promise<void> {
    this.state = "closed";
  }
}

class FakeMediaElement {
  addEventListener(_type: string, _cb: () => void): void {}
  play(): Promise<void> {
    return Promise.resolve();
  }
  pause(): void {}
}

/**
 * A global with the full surface a real page has, so `installHandleTracking` installs every wrapper it knows how
 * to -- the whole point of this fixture, and the one thing `run-completion.test.ts`'s fake cannot do.
 */
function pageGlobal(sent: WebToHostMessage[]): RunnerWebGlobal {
  const frames = new Map<number, (time: number) => void>();
  let nextFrame = 1;

  return {
    setTimeout: ((fn: () => void, ms?: number) => setTimeout(fn, ms)) as unknown as RunnerWebGlobal["setTimeout"],
    clearTimeout: clearTimeout as unknown as RunnerWebGlobal["clearTimeout"],
    setInterval: ((fn: () => void, ms?: number) => setInterval(fn, ms)) as unknown as RunnerWebGlobal["setInterval"],
    clearInterval: clearInterval as unknown as RunnerWebGlobal["clearInterval"],
    requestAnimationFrame: (cb: (time: number) => void) => {
      const id = nextFrame++;
      frames.set(id, cb);
      return id;
    },
    cancelAnimationFrame: (id: number) => {
      frames.delete(id);
    },
    fetch: (() => Promise.resolve(new Response("ok"))) as unknown as RunnerWebGlobal["fetch"],
    WebSocket: class FakeWebSocket {
      addEventListener(_type: string, _cb: () => void): void {}
      close(): void {}
    },
    AudioContext: FakeAudioContext,
    HTMLMediaElement: FakeMediaElement,
    addEventListener: () => {},
    removeEventListener: () => {},
    console: {},
    __electrobunSendToHost: (value: unknown) => sent.push((value as { message: WebToHostMessage }).message),
    // biome-ignore lint/suspicious/noExplicitAny: a stand-in global, exactly as handles.test.ts builds one
  } as any;
}

/**
 * Wraps each already-installed tracking wrapper so every tracked handle the *run* creates is named. Installed
 * after `startRunnerWeb`, so the bootstrap's own untracked heartbeat/flush timers are never seen -- see the file's
 * header.
 */
function recordTrackedCalls(g: RunnerWebGlobal): string[] {
  const calls: string[] = [];
  for (const name of ["setTimeout", "setInterval", "requestAnimationFrame", "fetch"] as const) {
    const wrapped = g[name] as (...args: unknown[]) => unknown;
    g[name] = (...args: unknown[]) => {
      calls.push(name);
      return wrapped(...args);
    };
  }
  for (const name of ["WebSocket", "AudioContext"] as const) {
    const Wrapped = g[name] as new (...args: unknown[]) => object;
    g[name] = class extends Wrapped {
      constructor(...args: unknown[]) {
        super(...args);
        calls.push(name);
      }
    };
  }
  const media = g.HTMLMediaElement as { prototype: { play: (...args: unknown[]) => unknown } };
  const play = media.prototype.play;
  media.prototype.play = function (this: unknown, ...args: unknown[]) {
    calls.push("HTMLMediaElement.play");
    return play.apply(this, args);
  };
  return calls;
}

/** Runs `code` on a `browser`-runtime page and returns the terminal `state` message it reported. */
async function runOnPage(code: string): Promise<{
  terminal: Extract<WebToHostMessage, { type: "state" }>;
  calls: string[];
}> {
  const sent: WebToHostMessage[] = [];
  const g = pageGlobal(sent);
  const handle = startRunnerWeb({ global: g, heartbeatMs: 10_000, runtime: "browser" });
  const calls = recordTrackedCalls(g);
  try {
    (g.__jslabHostMessage as (m: unknown) => void)({
      seq: 1,
      message: { type: "run", runId: "run-1", code, settings: { maxEntries: 100 } },
    });
    const deadline = Date.now() + 2000;
    for (;;) {
      const terminal = sent.find(
        (m): m is Extract<WebToHostMessage, { type: "state" }> => m.type === "state" && m.state !== "evaluating",
      );
      if (terminal) return { terminal, calls };
      if (Date.now() > deadline) throw new Error(`no terminal state; received ${JSON.stringify(sent)}`);
      await Bun.sleep(2);
    }
  } finally {
    handle.dispose();
  }
}

/**
 * The reported case, as the bundler actually delivers it: `const test: string = "test"` is transpiled to plain JS
 * and its binding wrapped by `@jslab/transform`'s auto-log call, which is all the page ever sees.
 */
test("a trivial browser run finishes idle with no active handles", async () => {
  const { terminal, calls } = await runOnPage('const test = __jl.log(1, "test");\n');
  expect({ state: terminal.state, activeHandles: terminal.activeHandles, calls }).toEqual({
    state: "idle",
    activeHandles: 0,
    calls: [],
  });
});

/** The same, for code that touches nothing at all -- no `__jl` call, no bindings. */
test("an empty browser run finishes idle with no active handles", async () => {
  const { terminal, calls } = await runOnPage("1 + 1;\n");
  expect({ state: terminal.state, activeHandles: terminal.activeHandles, calls }).toEqual({
    state: "idle",
    activeHandles: 0,
    calls: [],
  });
});
