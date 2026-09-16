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
import {
  type FetchHostEvent,
  type FetchProxyGlobal,
  type FetchTransport,
  installFetchProxy,
  type WebRuntime,
} from "./fetch-proxy";
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
  // would otherwise make `this` the object rather than the Window. `setTimeout`/`setInterval` are WebIDL
  // operations, whose receiver is specified to be the Window, so binding is right on the platform contract.
  // Task 9b correction: this comment used to assert that an unbound receiver throws "Illegal invocation" in WebKit
  // and that this was why a browser-mode page never finished a run. Task 9a's own in-page probe of the exact call
  // shape returned `method-ok` and the emitted bundle is not strict-mode, so that mechanism is unproven, and the
  // hang it was blamed for had a different cause entirely (the serializer's use of `Buffer`; see `startRun`).
  // The binding stays because the contract says so, not because of a diagnosis this codebase can demonstrate.
  const timers = { setTimeout: g.setTimeout.bind(g), clearTimeout: g.clearTimeout.bind(g) };
  const rawInterval = { setInterval: g.setInterval.bind(g), clearInterval: g.clearInterval.bind(g) };

  // Task 12/13 (spec §5.12): MUST run before `installHandleTracking` below wraps `fetch` -- that wrapper captures
  // whichever `fetch` the global holds at the moment it runs, and it's what keeps a run "active" while a request
  // is outstanding and releases the handle once the promise settles, including the rejection an abort produces.
  // Reversed, an aborted `browser-node` request would leak a handle forever (fetch-proxy.ts's own doc comment;
  // enforced here by bootstrap-fetch-order.test.ts, since a comment alone cannot catch this going forward).
  // Task 9b (ledger ruling R-M4-T13-FETCHWIRE-1): the **production** `browser-node` transport. Until this existed,
  // `web-entry.ts` called `startRunnerWeb()` with no arguments, so `options.fetchTransport` was always undefined and
  // the proxy was never installed in a real page -- `browser-node` silently got a plain CORS-enforced `fetch`, the
  // opposite of what spec §5.12 requires. The transport is built here rather than handed in by `web-entry.ts`
  // because only this function can route the host's replies back: they arrive as ordinary `HostToWebMessage`s in
  // `handleHostMessage` below, which is private to this closure. `options.fetchTransport` remains as the test seam.
  //
  // `bridge` is referenced here before its own `const` runs further down this function. That is safe for the same
  // reason `setState` closing over it is: nothing below is ever *called* until a run is underway, long after the
  // declaration has executed.
  const fetchListeners = new Set<(event: FetchHostEvent) => void>();
  const hostFetchTransport: FetchTransport = {
    request(id, request) {
      bridge.send({
        type: "fetchRequest",
        id,
        url: request.url,
        method: request.method,
        headers: request.headers,
        body: request.body,
      });
    },
    abort(id) {
      bridge.send({ type: "fetchAbort", id });
    },
    onEvent(listener) {
      fetchListeners.add(listener);
      return () => fetchListeners.delete(listener);
    },
  };
  /** Fans one host reply out to the proxy. The only consumer of the four `fetch*` cases in `handleHostMessage`. */
  const deliverFetch = (event: FetchHostEvent): void => {
    for (const listener of [...fetchListeners]) listener(event);
  };
  // Called unconditionally now: `installFetchProxy` is itself the no-op for `"browser"` (it does not wrap the
  // global and does not even subscribe -- `fetch-proxy.ts`), so the runtime, not the presence of a transport, is
  // what decides. That ordering requirement above (before `installHandleTracking`) is unchanged.
  installFetchProxy({
    runtime: options.runtime ?? "browser",
    transport: options.fetchTransport ?? hostFetchTransport,
    global: g as unknown as FetchProxyGlobal,
  });

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

  const resetConsole = installConsole(
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
    // Task 9d: the console hook's group depth, count tallies and timers are per-run state too, and this page is
    // never unmounted between runs -- so without this an unmatched `console.group()` would indent every later run.
    resetConsole();
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
      // Task 9b, defence in depth. `pushError` encodes the thrown value, and the encoder can itself throw -- which
      // is exactly how this failure stayed invisible for a whole milestone. A webview has no `Buffer`, so the
      // serializer's `jsonBytes` threw `ReferenceError` inside the user's first `console.log`; that rejected this
      // import, and then threw *again* here while encoding the rejection, propagating out of `startRun` before the
      // terminal state below could be sent. The tab sat in `evaluating` forever with no events and no error. The
      // root cause is fixed in `packages/serializer`, but a reporter that can throw must never again be the only
      // thing standing between a failed run and the host hearing about it.
      try {
        pushError("runtime", error);
      } catch {
        // A last-resort event that touches neither the encoder nor the thrown value's own accessors.
        try {
          run?.buffer.push({
            kind: "error",
            phase: "runtime",
            name: "RuntimeError",
            message: "This run failed, and JSLab could not encode the error it failed with.",
            stack: [],
            value: { t: "undefined" },
          });
        } catch {}
      }
    } finally {
      URL.revokeObjectURL(url);
    }
    if (current.state !== "evaluating") return;
    try {
      setState(tracker.count > 0 ? "settled" : "idle");
    } catch {
      // `setState` flushes the buffer before it sends, so a single unencodable queued event could otherwise take
      // the terminal state down with it. The state is the one message the host cannot do without: without it the
      // tab spins in `evaluating` until the user kills it. Send it directly, skipping the flush that failed.
      bridge.send({ type: "state", runId: current.runId, state: "idle", activeHandles: tracker.count });
    }
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
      // Task 9b: these now feed the production transport above. Task 13 left them as no-ops purely to keep the
      // `default` branch exhaustive, precisely so this wiring could not be added without the compiler checking it
      // -- an unrouted reply leaves the page's `fetch` promise pending forever, with no error and no timeout.
      case "fetchHead":
        deliverFetch({
          type: "head",
          id: message.id,
          status: message.status,
          statusText: message.statusText,
          headers: message.headers,
          url: message.url,
        });
        return;
      case "fetchChunk":
        deliverFetch({ type: "chunk", id: message.id, data: message.data });
        return;
      case "fetchEnd":
        deliverFetch({ type: "end", id: message.id });
        return;
      case "fetchError":
        deliverFetch({ type: "error", id: message.id, message: message.message });
        return;
      default: {
        const _never: never = message;
        void _never;
        return;
      }
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
