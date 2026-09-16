import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { types } from "node:util";
import type { MainToRunner, RunnerState, RunnerToMain } from "@jslab/rpc-schema";
import {
  clipToJsonBytes,
  DEFAULT_LIMITS,
  Encoder,
  HandleRegistry,
  jsonStringBytes,
  parseStack,
} from "@jslab/serializer";
import { installConsole, installStdio } from "./console-hook";
import { EventBuffer } from "./event-buffer";
import { HandleTracker, handleCountAction, installHandleTracking } from "./handles";

// Capture host timers before user-facing wrappers are installed; JSLab's own timers are never tracked.
const timers = {
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
  setInterval: globalThis.setInterval,
};
const heartbeatMs = Number(process.env.JSLAB_HEARTBEAT_MS ?? 500);
// An error event's text sits beside its budgeted `value` (R-M1-17(a)): bound it the same way.
const MAX_ERROR_MESSAGE_BYTES = 16 * 1024;
const MAX_ERROR_FRAMES = 50;
const MAX_FRAME_TEXT_BYTES = 1024;
const MAX_ERROR_NAME_BYTES = 1024;
/** One stdout/stderr chunk fits one event's 256 KB value budget, with room left for the event's other fields. */
const MAX_STDIO_TEXT_BYTES = DEFAULT_LIMITS.maxEncodedBytes - 1024;
const CUT_MARK = "…";
/**
 * Cuts text to at most `maxBytes` of JSON UTF-8 bytes, marked with "…", never between the halves of a surrogate pair.
 * A ReferenceError for a 6 MB identifier otherwise carries the whole identifier, and rendering that one output row
 * freezes the UI (Task 18, R-M2-T18-2; fix round 1, m-2). Task 19 measures the cap in exact bytes.
 */
const clipText = (text: string, maxBytes: number) =>
  jsonStringBytes(text) <= maxBytes
    ? text
    : `${clipToJsonBytes(text, maxBytes - jsonStringBytes(CUT_MARK))}${CUT_MARK}`;
/** Clips one stdout/stderr write to its event budget and says how many UTF-8 bytes were dropped (R-M2-T19B-1). */
const clipStdio = (text: string) => {
  if (jsonStringBytes(text) <= MAX_STDIO_TEXT_BYTES) return text;
  const total = Buffer.byteLength(text);
  // Room for the suffix is reserved first, sized for the largest count it can show.
  const kept = clipToJsonBytes(text, MAX_STDIO_TEXT_BYTES - jsonStringBytes(`${CUT_MARK} [${total} bytes not shown]`));
  return `${kept}${CUT_MARK} [${total - Buffer.byteLength(kept)} bytes not shown]`;
};
const send = (message: RunnerToMain) => process.send?.(message);
// The real exit, captured before user code can see process.exit (FA-I4). JSLab's own exits use it directly.
const exitProcess = process.exit.bind(process) as (code?: number | string | null) => never;
/** How long a user process.exit waits for queued IPC to reach Main before exiting anyway. */
const EXIT_DRAIN_TIMEOUT_MS = 2000;
/** Thrown by the user-facing process.exit to unwind the caller's remaining code; never reported as an error. */
const EXIT_SIGNAL = Symbol("jslab.processExit");
let exiting = false;
const hooks = {
  peekPromise: (promise: Promise<unknown>) => {
    const state = Bun.peek.status(promise);
    return state === "pending" ? { state } : { state, value: Bun.peek(promise) };
  },
  isProxy: (value: object) => types.isProxy(value),
};

interface Run {
  runId: string;
  entryBase: string;
  buffer: EventBuffer;
  encoder: Encoder;
  state: RunnerState;
}

let run: Run | null = null;
const registry = new HandleRegistry();

const tracker = new HandleTracker((count) => {
  if (!run) return;
  // Untracked continuations (an awaited Bun.sleep, an un-awaited promise) can resume after Stop and create new
  // handles: dispose them at once so stopped user code can't keep timers, servers or sockets alive. The same applies
  // after a caught process.exit (FW1).
  const action = handleCountAction(run.state, exiting, count);
  if (action === "dispose") tracker.disposeAll();
  else if (action) setState(action);
});
installHandleTracking(tracker);

function setState(state: RunnerState): void {
  // A run that ended with process.exit reports no further state: Main reports the exit itself.
  if (!run || exiting) return;
  run.state = state;
  run.buffer.flush();
  send({ type: "state", runId: run.runId, state, activeHandles: tracker.count });
}

function pushError(phase: "runtime" | "unhandledRejection", error: unknown): void {
  if (!run || run.state === "stopped" || error === EXIT_SIGNAL) return;
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

/** Polls (never attaches handlers, so unhandled rejections still surface) and reports settlement. */
function watchPromise(value: unknown, ref: number | null): void {
  if (ref === null || !(value instanceof Promise) || Bun.peek.status(value) !== "pending") return;
  const current = run;
  let delay = 16;
  const poll = () => {
    if (!current || run !== current) return;
    if (Bun.peek.status(value) === "pending") {
      delay = Math.min(delay * 2, 500);
      timers.setTimeout(poll, delay);
      return;
    }
    current.buffer.push({ kind: "promiseSettled", ref, value: current.encoder.encode(value) });
  };
  timers.setTimeout(poll, delay);
}

Object.defineProperty(globalThis, "__jl", {
  enumerable: false,
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

installConsole({
  push: (body) => run?.buffer.push(body) ?? null,
  // A stopped run's buffer is closed, so don't spend time encoding values that would be dropped.
  encodeMany: (values) =>
    run && run.state !== "stopped" ? run.encoder.encodeMany(values) : values.map(() => ({ t: "undefined" })),
  entryBase: () => run?.entryBase ?? null,
});
installStdio((kind, text) => {
  // One huge write must not become a multi-megabyte event: stdio text has no value budget of its own (R-M1-17(a)).
  run?.buffer.push({ kind, text: clipStdio(text) });
});

process.on("uncaughtException", (error) => pushError("runtime", error));
process.on("unhandledRejection", (reason) => pushError("unhandledRejection", reason));
process.on("disconnect", () => exitProcess(0));
// Any other exit path still flushes what is queued. `close()` (M1 fix wave) flushes and then drops anything pushed later.
process.on("exit", () => run?.buffer.close());

/**
 * FA-I4 (spec §5.11): Bun drops IPC messages still queued when a process exits, so `console.log("done");
 * process.exit(0)` lost its tail (and a large final batch lost everything). User code gets a process.exit that
 * flushes the run's output, stops its handles, and exits only once Bun confirms the queued messages were written
 * (the send callback), or after EXIT_DRAIN_TIMEOUT_MS. It throws EXIT_SIGNAL so the code after the call doesn't run.
 */
process.exit = ((code?: number | string | null) => {
  if (exiting) throw EXIT_SIGNAL;
  exiting = true;
  const exitCode = code ?? process.exitCode;
  run?.buffer.close();
  tracker.disposeAll();
  const requested = Number(exitCode ?? 0);
  // FW1 / R-M3-T17-FIX-1: the status a real process exit reports (8 bits); anything that isn't a safe integer is 1.
  const exitStatus = Number.isSafeInteger(requested) ? ((requested % 256) + 256) % 256 : 1;
  send({ type: "exitRequested", runId: run?.runId ?? "", code: exitStatus });
  timers.setTimeout(() => exitProcess(exitStatus), EXIT_DRAIN_TIMEOUT_MS);
  try {
    // Bun calls this back once the message, and everything queued before it, has been written.
    process.send?.({ type: "heartbeat" } satisfies RunnerToMain, undefined, undefined, () => exitProcess(exitStatus));
    if (!process.send) exitProcess(exitStatus);
  } catch {
    exitProcess(exitStatus);
  }
  throw EXIT_SIGNAL;
}) as typeof process.exit;

async function startRun(message: Extract<MainToRunner, { type: "run" }>): Promise<void> {
  if (run) return;
  const current: Run = {
    runId: message.runId,
    entryBase: basename(message.entry),
    buffer: new EventBuffer(
      (events) => send({ type: "events", runId: message.runId, events }),
      message.settings.maxEntries,
      timers,
    ),
    encoder: new Encoder(registry, DEFAULT_LIMITS, hooks),
    state: "evaluating",
  };
  run = current;
  setState("evaluating");
  try {
    await import(pathToFileURL(message.entry).href);
  } catch (error) {
    pushError("runtime", error);
  }
  if (current.state !== "evaluating") return;
  setState(tracker.count > 0 ? "settled" : "idle");
}

process.on("message", (message: MainToRunner) => {
  switch (message.type) {
    case "run":
      void startRun(message);
      return;
    case "stop":
      if (run) run.state = "stopped";
      tracker.disposeAll();
      setState("stopped");
      // setState flushed everything buffered before Stop; nothing the run does afterwards may cross IPC.
      run?.buffer.close();
      return;
    case "expand":
      send({ type: "expanded", reqId: message.reqId, value: run?.encoder.expand(message.handleId) ?? null });
      return;
    case "dispose":
      exitProcess(0);
  }
});

timers.setInterval(() => send({ type: "heartbeat" }), heartbeatMs);
send({ type: "ready", bunVersion: Bun.version });
