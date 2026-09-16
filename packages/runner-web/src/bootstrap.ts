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
import { HandleTracker, handleCountAction, installHandleTracking } from "./handles";
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
}

export interface RunnerWebHandle {
  /** Tears the runner down: stops the heartbeat, disposes active handles, and removes every installed hook. */
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
  const heartbeatMs = options.heartbeatMs ?? 500;
  // Captured before `installHandleTracking` wraps `g`'s timers (mirrors packages/runner-bun/src/bootstrap.ts):
  // JSLab's own EventBuffer flush timer and heartbeat interval are never tracked as user-code activity.
  const timers = { setTimeout: g.setTimeout, clearTimeout: g.clearTimeout };
  const rawInterval = { setInterval: g.setInterval, clearInterval: g.clearInterval };

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
  installHandleTracking(tracker, g);

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
    // The Bun runner marks this non-configurable (a fresh OS process per run makes that free hardening). A page
    // is also only ever bootstrapped once per its lifetime in production, but leaving this configurable lets an
    // in-process test create more than one runner instance in a row without a "Cannot redefine property" throw.
    configurable: true,
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
      bridge.dispose();
      delete (g as { __jl?: unknown }).__jl;
    },
  };
}
