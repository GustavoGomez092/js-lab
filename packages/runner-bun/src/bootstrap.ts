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
import { HandleTracker, installHandleTracking } from "./handles";

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
  // handles: dispose them at once so stopped user code can't keep timers, servers or sockets alive.
  if (run.state === "stopped" && count > 0) tracker.disposeAll();
  else if (run.state === "settled" && count === 0) setState("idle");
  else if (run.state === "idle" && count > 0) setState("settled");
});
installHandleTracking(tracker);

function setState(state: RunnerState): void {
  if (!run) return;
  run.state = state;
  run.buffer.flush();
  send({ type: "state", runId: run.runId, state, activeHandles: tracker.count });
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
process.on("disconnect", () => process.exit(0));
// Final review M5: events queued since the last flush (for example `console.log("done"); process.exit(0)`) are sent
// before the process exits. `exit` listeners run synchronously, before the IPC channel closes. `close()` (M1 fix wave)
// flushes and then drops anything pushed later.
process.on("exit", () => run?.buffer.close());

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
      process.exit(0);
  }
});

timers.setInterval(() => send({ type: "heartbeat" }), heartbeatMs);
send({ type: "ready", bunVersion: Bun.version });
