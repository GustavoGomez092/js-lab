import type { EncodedValue, StackFrame } from "./values";

export type ConsoleLevel =
  | "log"
  | "info"
  | "warn"
  | "error"
  | "debug"
  | "dir"
  | "table"
  | "trace"
  | "assert"
  | "count"
  | "time"
  | "group"
  | "groupCollapsed"
  | "groupEnd"
  | "clear";

export interface GeneratedPosition {
  line: number;
  column: number;
}

export type RawRunEventBody =
  | { kind: "result"; line: number; column?: number; source: "autolog" | "magic"; value: EncodedValue }
  | {
      kind: "console";
      level: ConsoleLevel;
      at?: GeneratedPosition;
      groupDepth: number;
      args: EncodedValue[];
      label?: string;
      stack?: StackFrame[];
    }
  | { kind: "stdout" | "stderr"; text: string }
  | {
      kind: "error";
      phase: "runtime" | "unhandledRejection";
      name: string;
      message: string;
      stack: StackFrame[];
      value: EncodedValue;
    }
  | { kind: "promiseSettled"; ref: number; value: EncodedValue }
  | { kind: "truncated"; dropped: number };

export type RawRunEvent = RawRunEventBody & { seq: number; t: number };

export type RunnerState = "evaluating" | "settled" | "idle" | "stopped";

export type MainToRunner =
  | { type: "run"; runId: string; entry: string; settings: { maxEntries: number } }
  | { type: "stop" }
  | { type: "expand"; reqId: number; handleId: string }
  | { type: "dispose" };

export type RunnerToMain =
  | { type: "ready"; bunVersion: string }
  | { type: "heartbeat" }
  | { type: "events"; runId: string; events: RawRunEvent[] }
  | { type: "state"; runId: string; state: RunnerState; activeHandles: number }
  | { type: "expanded"; reqId: number; value: EncodedValue | null }
  /** User code called process.exit (FW1): later output is ignored, and Main ends the runner if it doesn't exit. */
  | { type: "exitRequested"; runId: string; code: number };

/**
 * The `browser`/`browser-node` transport (Task 3, M4): the runner-web bootstrap runs inside a webview page with
 * no process IPC. Messages cross via `window.__electrobunSendToHost` (page → host) and an injected
 * `window.__jslabHostMessage` the host calls through `executeJavascript` (host → page). Both directions are JSON
 * values only, each wrapped with a monotonic `seq` so either side can detect a stale, duplicate or reordered
 * delivery from that call mechanism. `HostToWebMessage`/`WebToHostMessage` sit beside `MainToRunner`/`RunnerToMain`
 * rather than reusing them: there is no Bun version to report, no filesystem entry path (the host sends already
 * bundled module source instead), and no `process.exit` equivalent to model.
 *
 * `run.code` is evaluated through a `Blob` URL (`URL.createObjectURL` + dynamic `import()`), the only portable way
 * to run an ES module from a string in both a browser and Bun's own module loader; a `//# sourceURL` comment does
 * not relabel stack frames for a module the way it does for `eval`, so the bootstrap uses the blob URL itself
 * (not a host-supplied name) as the "entry" file `console-hook.ts` matches call sites against.
 */
export type HostToWebMessage =
  | { type: "run"; runId: string; code: string; settings: { maxEntries: number } }
  | { type: "stop" }
  | { type: "expand"; reqId: number; handleId: string }
  | { type: "dispose" };

export type WebToHostMessage =
  | { type: "ready" }
  | { type: "heartbeat" }
  | { type: "events"; runId: string; events: RawRunEvent[] }
  | { type: "state"; runId: string; state: RunnerState; activeHandles: number }
  | { type: "expanded"; reqId: number; value: EncodedValue | null };

/** Host → page envelope, delivered by calling `window.__jslabHostMessage(envelope)` through `executeJavascript`. */
export interface HostToWeb {
  seq: number;
  message: HostToWebMessage;
}

/** Page → host envelope, delivered by calling `window.__electrobunSendToHost(envelope)`. */
export interface WebToHost {
  seq: number;
  message: WebToHostMessage;
}
