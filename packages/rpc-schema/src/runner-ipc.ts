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
  | { kind: "truncated"; dropped: number }
  /**
   * Task 13 (spec §5.12, M0-S4): the web runner's own non-blocking `alert` shim -- `packages/runner-web/src/
   * dialogs.ts` pushes one of these per `alert()` call, carrying the message text. Not rendered inline with the
   * rest of a run's console output: `apps/ui`'s reducer routes it into its own display, the same way
   * `promiseSettled`/`truncated` are excluded from `DisplayEvent` for their own reasons.
   */
  | { kind: "dialog"; text: string };

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
  // `muted` (Task 15): the tab's saved mute preference, applied the instant the run starts -- every run gets a
  // fresh realm (spec §5.12 decision 1), so without it a muted tab would come back unmuted on the next Run.
  // Optional (default false), so a caller (and every test fixture) that predates this task is unaffected.
  | { type: "run"; runId: string; code: string; settings: { maxEntries: number }; muted?: boolean }
  | { type: "stop" }
  | { type: "expand"; reqId: number; handleId: string }
  | { type: "dispose" }
  /**
   * Task 15 (spec §5.12, EX-35): sets or clears mute for the page's whole lifetime, not just the current run --
   * every tracked AudioContext's inserted gain node goes to 0 (or back to 1) and every currently playing tracked
   * media element is paused, without suspending any AudioContext (a suspended context stops its own clock, which
   * would desync anything the run times off it, such as a rAF-driven visualisation).
   */
  | { type: "mute"; muted: boolean }
  /**
   * Task 12/13, fix round 1 (spec §5.12): the `browser-node` fetch proxy's reply, streamed back on this same
   * per-tab channel -- `head` once, then zero or more `chunk`s, then exactly one of `end`/`error`. Carries no
   * `tabId`: this message only ever reaches the page whose webview it was sent to, the same way every other
   * `HostToWebMessage` does, so there is nothing for a page to spoof here even in principle.
   */
  | { type: "fetchHead"; id: number; status: number; statusText: string; headers: [string, string][]; url: string }
  | { type: "fetchChunk"; id: number; data: string }
  | { type: "fetchEnd"; id: number }
  | { type: "fetchError"; id: number; message: string };

export type WebToHostMessage =
  | { type: "ready" }
  | { type: "heartbeat" }
  | { type: "events"; runId: string; events: RawRunEvent[] }
  | { type: "state"; runId: string; state: RunnerState; activeHandles: number }
  | { type: "expanded"; reqId: number; value: EncodedValue | null }
  /** Task 15: pushed whenever the page's audio-active state changes (handles.ts's AudioController), not polled. */
  | { type: "audio"; active: boolean }
  /**
   * Task 12/13, fix round 1 (spec §5.12): one `browser-node` fetch request/abort. Carries no `tabId` -- unlike the
   * old `webFetch.request`/`webFetch.abort` RPC messages this replaces, which took one in a flat payload a
   * `browser` tab could forge to name a `browser-node` tab and get a CORS-free request issued on its behalf. Which
   * tab this belongs to is now derived from the connection it arrived on (`WebRunSession`, `apps/desktop/src/main/
   * runtimes/web-adapter.ts`), never from a field in the message itself.
   */
  | { type: "fetchRequest"; id: number; url: string; method: string; headers: [string, string][]; body: string | null }
  | { type: "fetchAbort"; id: number };

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
