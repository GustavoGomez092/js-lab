import type { ConsoleLevel } from "./runner-ipc";
import type { EncodedValue, StackFrame } from "./values";

export type RunEventBody =
  | { kind: "result"; line: number; column?: number; source: "autolog" | "magic" | "logpoint"; value: EncodedValue }
  | {
      kind: "console";
      level: ConsoleLevel;
      line?: number;
      groupDepth: number;
      args: EncodedValue[];
      label?: string;
      stack?: StackFrame[];
    }
  | { kind: "stdout" | "stderr"; text: string }
  | {
      kind: "error";
      phase: "transpile" | "runtime" | "unhandledRejection" | "runner";
      name: string;
      message: string;
      line?: number;
      column?: number;
      stack: StackFrame[];
      codeFrame?: string;
      value?: EncodedValue;
    }
  | { kind: "promiseSettled"; ref: number; value: EncodedValue }
  | { kind: "truncated"; dropped: number }
  /** Task 13: mirrors `RawRunEventBody`'s own "dialog" variant (`runner-ipc.ts`) -- see its comment. */
  | { kind: "dialog"; text: string };

export type RunEvent = RunEventBody & { seq: number; t: number };

export type RunState =
  | "transpiling"
  | "evaluating"
  | "settled"
  | "idle"
  | "unresponsive"
  | "stopping"
  | "stopped"
  | "killed"
  | "failed";
