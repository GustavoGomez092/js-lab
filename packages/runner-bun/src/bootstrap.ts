import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { types } from "node:util";
import type { MainToRunner, RunnerState, RunnerToMain } from "@jslab/rpc-schema";
import { DEFAULT_LIMITS, Encoder, HandleRegistry, parseStack } from "@jslab/serializer";
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
/**
 * Error names and messages are capped where they are created. A ReferenceError for a 6 MB identifier otherwise
 * carries the whole identifier, and rendering that one output row freezes the UI (Task 18, R-M2-T18-2). Task 19's
 * exact-byte error-text budgets refine this.
 */
const MAX_ERROR_TEXT_CHARS = 10_000;
const capErrorText = (text: string) => {
  if (text.length <= MAX_ERROR_TEXT_CHARS) return text;
  // Never cut between the halves of a surrogate pair (fix round 1, m-2).
  const last = text.charCodeAt(MAX_ERROR_TEXT_CHARS - 1);
  return `${text.slice(0, last >= 0xd800 && last <= 0xdbff ? MAX_ERROR_TEXT_CHARS - 1 : MAX_ERROR_TEXT_CHARS)}…`;
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
    name: capErrorText(typeof e?.name === "string" ? e.name : "Error"),
    message: capErrorText(typeof e?.message === "string" ? e.message : String(error)),
    stack: parseStack(typeof e?.stack === "string" ? e.stack : ""),
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
  run?.buffer.push({ kind, text });
});

process.on("uncaughtException", (error) => pushError("runtime", error));
process.on("unhandledRejection", (reason) => pushError("unhandledRejection", reason));
process.on("disconnect", () => process.exit(0));

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
