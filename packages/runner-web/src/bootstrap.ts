import type { HostToWebMessage, RunnerState } from "@jslab/rpc-schema";
import { EventBuffer } from "@jslab/runner-shared";
import {
  clipToJsonBytes,
  DEFAULT_LIMITS,
  Encoder,
  HandleRegistry,
  jsonStringBytes,
  parseStack,
} from "@jslab/serializer";
import { installConsole } from "./console-hook";
import { type DialogGlobal, installDialogShim } from "./dialogs";
import { type FetchProxyGlobal, type FetchTransport, installFetchProxy, type WebRuntime } from "./fetch-proxy";
import { AudioController, HandleTracker, handleCountAction, installHandleTracking } from "./handles";
import { createHostBridge, type HostBridgeGlobal } from "./host-bridge";

// Same limits as packages/runner-bun/src/bootstrap.ts (spec §5.9, R-M1-17(a)): an error event's text sits beside
// its budgeted `value`, bounded the same way in both runners.
const MAX_ERROR_MESSAGE_BYTES = 16 * 1024;
const MAX_ERROR_FRAMES = 50;
const MAX_FRAME_TEXT_BYTES = 1024;
const MAX_ERROR_NAME_BYTES = 1024;
const CUT_MARK = "…";
const clipText = (text: string, maxBytes: number) =>
  jsonStringBytes(text) <= maxBytes
    ? text
    : `${clipToJsonBytes(text, maxBytes - jsonStringBytes(CUT_MARK))}${CUT_MARK}`;

/** The subset of `globalThis` the web bootstrap touches; a real page, or a fake built for tests. */
export interface RunnerWebGlobal extends HostBridgeGlobal {
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
  setInterval: typeof setInterval;
  clearInterval: typeof clearInterval;
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
  // biome-ignore lint/suspicious/noExplicitAny: every other host API (WebSocket, AudioContext, ...) is optional
  [key: string]: any;
}

export interface RunnerWebOptions {
  global?: RunnerWebGlobal;
  /** Defaults to the same 500 ms as the Bun runner. */
  heartbeatMs?: number;
  /**
   * Task 13 (spec §5.12): which web runtime this page is running as. Determines whether `installFetchProxy` does
   * anything at all -- it's a no-op for `"browser"` (see `fetch-proxy.ts`'s own doc comment). Defaults to
   * `"browser"`, the safe, CORS-enforced choice, so a caller that hasn't wired runtime detection through yet gets
   * no proxy rather than an accidental one.
   */
  runtime?: WebRuntime;
  /**
   * Task 13: the `browser-node` fetch proxy's host transport (`fetch-proxy.ts`). Wiring a real, production
   * transport to the host bridge is a later integration's job -- the same way `RawWebview`'s real implementation
   * (`apps/desktop/src/main/runtimes/web-adapter.ts`) was out of an earlier task's scope until a live webview
   * existed. Omitting it here simply skips installing the proxy, exactly like `runtime: "browser"` does.
   */
  fetchTransport?: FetchTransport;
}

export interface RunnerWebHandle {
  /**
   * Tears the runner down: stops the heartbeat, disposes active handles, clears the expand registry, and removes
   * the error/rejection listeners and the host bridge's inbound hook. `__jl`, `console`, `alert`/`confirm`/`prompt`
   * and the wrapped timer/fetch/WebSocket/... globals stay installed, since `__jl` is non-configurable and the
   * others are meant to outlive any one run for the lifetime of the page (or, in a test, the file that shares one
   * bootstrap instance).
   */
  dispose(): void;
}

interface Run {
  runId: string;
  entryBase: string;
  buffer: EventBuffer;
  encoder: Encoder;
  state: RunnerState;
}

export function startRunnerWeb(options: RunnerWebOptions = {}): RunnerWebHandle {
  const g = (options.global ?? (globalThis as unknown as RunnerWebGlobal)) as RunnerWebGlobal;

  // Task 13 (spec §5.12, M0-S4): this function's first statement after resolving `g`, before any user code can
  // possibly run -- so a native `alert`/`confirm`/`prompt` panel has no chance to flash behind the shim. There is
  // no native call left for one to flash from at all: the globals are replaced outright (see dialogs.ts's own
  // module doc). `run` is referenced inside the closure below before its `let` runs further down this function --
  // safe because the closure is only ever called once a run is actually underway, exactly like `setState` below
  // closes over `bridge`, declared later in this same function, for the same reason.
  const dialogShim = installDialogShim({
    // `g`'s index signature makes every one of `DialogGlobal`'s properties structurally present, but TS's "weak
    // type" check for an all-optional target still wants an explicit cast (the same reason `handles.ts` below
    // types its own `g` parameter as `any` rather than a named interface).
    global: g as unknown as DialogGlobal,
    sink: {
      push(body) {
        run?.buffer.push(body);
      },
    },
  });

  const heartbeatMs = options.heartbeatMs ?? 500;
  // Captured before `installHandleTracking` wraps `g`'s timers (mirrors packages/runner-bun/src/bootstrap.ts):
  // JSLab's own EventBuffer flush timer and heartbeat interval are never tracked as user-code activity.
  // Bound to the global deliberately. These are captured before `installHandleTracking` wraps them, and they are
  // then called as methods of these plain objects (`timers.setTimeout(...)`, `rawInterval.setInterval(...)`), which
  // makes `this` the object rather than the Window. A WebIDL operation with a receiver that isn't the Window
  // throws "Illegal invocation" in WebKit -- fatal here, because it happens between installing the host bridge and
  // `bridge.send({ type: "ready" })` below, so the page never reports ready and the host can only time out with
  // nothing to show the user. Bun ignores the receiver entirely, which is why every unit test passed regardless.
  const timers = { setTimeout: g.setTimeout.bind(g), clearTimeout: g.clearTimeout.bind(g) };
  const rawInterval = { setInterval: g.setInterval.bind(g), clearInterval: g.clearInterval.bind(g) };

  // Task 12/13 (spec §5.12): MUST run before `installHandleTracking` below wraps `fetch` -- that wrapper captures
  // whichever `fetch` the global holds at the moment it runs, and it's what keeps a run "active" while a request
  // is outstanding and releases the handle once the promise settles, including the rejection an abort produces.
  // Reversed, an aborted `browser-node` request would leak a handle forever (fetch-proxy.ts's own doc comment;
  // enforced here by bootstrap-fetch-order.test.ts, since a comment alone cannot catch this going forward).
  if (options.fetchTransport) {
    installFetchProxy({
      runtime: options.runtime ?? "browser",
      transport: options.fetchTransport,
      global: g as unknown as FetchProxyGlobal,
    });
  }

  let run: Run | null = null;
  const registry = new HandleRegistry();

  const tracker = new HandleTracker((count) => {
    if (!run) return;
    // A run that keeps creating handles after Stop (an un-awaited continuation) must not keep the page "active":
    // dispose them at once, mirroring the Bun runner's FW1 rule.
    const action = handleCountAction(run.state, false, count);
    if (action === "dispose") tracker.disposeAll();
    else if (action) setState(action);
  });
  // Task 15 (spec §5.12, EX-35): reports the tab's audio-active state to the host the moment it changes -- never
  // polled. Outlives any one run, exactly like the wrapped globals `installHandleTracking` installs: an
  // AudioContext or media element created by one run can still be open/playing when the next run's page reloads
  // it away, at which point this whole realm (and this AudioController with it) is discarded anyway.
  const audio = new AudioController((active) => bridge.send({ type: "audio", active }));
  installHandleTracking(tracker, g, audio);

  function setState(state: RunnerState): void {
    if (!run) return;
    run.state = state;
    run.buffer.flush();
    bridge.send({ type: "state", runId: run.runId, state, activeHandles: tracker.count });
  }

  function pushError(phase: "runtime" | "unhandledRejection", error: unknown): void {
    if (!run || run.state === "stopped") return;
    const e = error as { name?: unknown; message?: unknown; stack?: unknown } | null;
    run.buffer.push({
      kind: "error",
      phase,
      name: clipText(typeof e?.name === "string" ? e.name : "Error", MAX_ERROR_NAME_BYTES),
      message: clipText(typeof e?.message === "string" ? e.message : String(error), MAX_ERROR_MESSAGE_BYTES),
      stack: parseStack(typeof e?.stack === "string" ? e.stack : "")
        .slice(0, MAX_ERROR_FRAMES)
        .map((frame) => ({
          ...frame,
          ...(frame.fn ? { fn: clipToJsonBytes(frame.fn, MAX_FRAME_TEXT_BYTES) } : {}),
          ...(frame.file ? { file: clipToJsonBytes(frame.file, MAX_FRAME_TEXT_BYTES) } : {}),
        })),
      value: run.encoder.encode(error),
    });
  }

  /**
   * Reports a `__jl`-watched value's eventual settlement. A browser has no non-invasive way to peek a Promise's
   * state the way `Bun.peek` does (that is a Bun-only VM hook): attaching `.then` here is the only portable option,
   * which means — unlike the Bun runner — a rejection surfaced this way also counts as "handled" and will not also
   * reach `window.addEventListener("unhandledrejection")`. This is a deliberate, documented divergence (see the
   * task report), not an oversight.
   */
  function watchPromise(value: unknown, ref: number | null): void {
    if (ref === null || !(value instanceof Promise)) return;
    const current = run;
    value.then(
      (resolved) => {
        if (run === current)
          current?.buffer.push({ kind: "promiseSettled", ref, value: current.encoder.encode(resolved) });
      },
      (rejected) => {
        if (run === current)
          current?.buffer.push({ kind: "promiseSettled", ref, value: current.encoder.encode(rejected) });
      },
    );
  }

  Object.defineProperty(g, "__jl", {
    enumerable: false,
    // Matches packages/runner-bun/src/bootstrap.ts exactly: a run executes as an ES module, so its top-level code
    // is implicit strict mode, where `delete globalThis.__jl` on a configurable property would silently succeed
    // and let the run install its own stub — every later `__jl.log`/`__jl.mc` would then report nothing, with no
    // error and no event (fix round 1, C1). `configurable: false` makes that same `delete` throw instead, exactly
    // as it already does on Bun. Tests inject the object this instruments (see `RunnerWebOptions.global`) instead
    // of weakening this descriptor, and share one bootstrap instance per test file for the same reason Bun's own
    // runner never re-installs `__jl` either: a real page, like a real Bun process, is only ever bootstrapped once.
    configurable: false,
    writable: false,
    value: {
      log(line: number, value: unknown) {
        if (run)
          watchPromise(
            value,
            run.buffer.push({ kind: "result", line, source: "autolog", value: run.encoder.encode(value) }),
          );
        return value;
      },
      mc(line: number, column: number, value: unknown, format?: ($: unknown) => unknown) {
        if (run) {
          let shown = value;
          if (format) {
            try {
              shown = format(value);
            } catch (error) {
              shown = error;
            }
          }
          watchPromise(
            shown,
            run.buffer.push({ kind: "result", line, column, source: "magic", value: run.encoder.encode(shown) }),
          );
        }
        return value;
      },
    },
  });

  installConsole(
    {
      push: (body) => run?.buffer.push(body) ?? null,
      encodeMany: (values) =>
        run && run.state !== "stopped" ? run.encoder.encodeMany(values) : values.map(() => ({ t: "undefined" })),
      entryBase: () => run?.entryBase ?? null,
    },
    g.console as Console,
  );

  const onError = (event: unknown) => {
    const e = event as { error?: unknown; message?: unknown } | null;
    pushError("runtime", e?.error ?? (typeof e?.message === "string" ? new Error(e.message) : event));
  };
  const onRejection = (event: unknown) =>
    pushError("unhandledRejection", (event as { reason?: unknown } | null)?.reason);
  g.addEventListener("error", onError);
  g.addEventListener("unhandledrejection", onRejection);

  const bridge = createHostBridge(handleHostMessage, g);

  async function startRun(message: Extract<HostToWebMessage, { type: "run" }>): Promise<void> {
    if (run) return;
    // The expand registry is scoped to the run (fix round 1, I2), not to this bootstrap instance: a handle id
    // from a previous run must never resolve against a later one. `registry` is otherwise process/page-lifetime
    // state shared only because `Encoder` needs a fresh instance wrapped around it every run.
    registry.clear();
    // Task 13: "once per run, not once per call" -- a fresh run gets to see the console warning again if it calls
    // alert/confirm/prompt, the same way every other per-run bit of state above is reset here.
    dialogShim.startRun();
    // Task 15: re-asserts the tab's saved mute preference before any user code can create an AudioContext or
    // media element -- a no-op when it already matches (AudioController.setMuted), so an explicit `mute` message
    // arriving separately (spec §5.12, a live toggle mid-run) is never fought over by this.
    audio.setMuted(message.muted ?? false);
    // A Blob URL is the only portable way to run an ES module from a string in both a browser and Bun's own
    // module loader (no `//# sourceURL`-style relabeling applies to modules): the blob URL itself becomes the
    // "entry" file console-hook.ts matches call sites against, so every top-level frame of the user's code matches
    // exactly, with no host-supplied name required.
    const url = URL.createObjectURL(new Blob([message.code], { type: "text/javascript" }));
    const current: Run = {
      runId: message.runId,
      entryBase: url,
      buffer: new EventBuffer(
        (events) => bridge.send({ type: "events", runId: message.runId, events }),
        message.settings.maxEntries,
        timers,
      ),
      encoder: new Encoder(registry, DEFAULT_LIMITS),
      state: "evaluating",
    };
    run = current;
    setState("evaluating");
    try {
      await import(url);
    } catch (error) {
      pushError("runtime", error);
    } finally {
      URL.revokeObjectURL(url);
    }
    if (current.state !== "evaluating") return;
    setState(tracker.count > 0 ? "settled" : "idle");
  }

  function handleHostMessage(message: HostToWebMessage): void {
    switch (message.type) {
      case "run":
        void startRun(message);
        return;
      case "mute":
        // Task 15: page-lifetime, not run-scoped -- toggling mute while nothing is running still takes effect the
        // moment a new AudioContext or media element is created (AudioController.addContext/addPlaying apply the
        // current mute state immediately).
        audio.setMuted(message.muted);
        return;
      case "stop":
        if (run) run.state = "stopped";
        tracker.disposeAll();
        setState("stopped");
        run?.buffer.close();
        return;
      case "expand":
        bridge.send({ type: "expanded", reqId: message.reqId, value: run?.encoder.expand(message.handleId) ?? null });
        return;
      case "dispose":
        tracker.disposeAll();
        run?.buffer.close();
        run = null;
        registry.clear();
        return;
    }
  }

  const heartbeatId = rawInterval.setInterval(() => bridge.send({ type: "heartbeat" }), heartbeatMs);
  bridge.send({ type: "ready" });

  return {
    dispose(): void {
      rawInterval.clearInterval(heartbeatId);
      g.removeEventListener("error", onError);
      g.removeEventListener("unhandledrejection", onRejection);
      tracker.disposeAll();
      run?.buffer.close();
      run = null;
      registry.clear();
      bridge.dispose();
      // `__jl` is intentionally left in place: it is non-configurable (see the comment above its definition), so
      // it cannot be removed even here, the same way a Bun runner process never un-defines it either.
    },
  };
}
