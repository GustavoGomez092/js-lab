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
