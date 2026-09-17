import { describe, expect, test } from "bun:test";
import type { RunEvent } from "@jslab/rpc-schema";
import {
  applyRunEvents,
  applyRunState,
  dismissWebDialog,
  initialOutput,
  type OutputState,
  visibleEntries,
} from "../src/state/output";

let seq = 0;
const result = (line: number, v: string): RunEvent => ({
  kind: "result",
  line,
  source: "autolog",
  value: { t: "number", v },
  seq: ++seq,
  t: 0,
});
const log = (text: string): RunEvent => ({
  kind: "console",
  level: "log",
  groupDepth: 0,
  args: [{ t: "string", v: text }],
  seq: ++seq,
  t: 0,
});
const transpileError = (): RunEvent => ({
  kind: "error",
  phase: "transpile",
  name: "SyntaxError",
  message: "Unexpected token",
  line: 1,
  stack: [],
  seq: ++seq,
  t: 0,
});

function withRun(runId: string, events: RunEvent[], state: OutputState = initialOutput): OutputState {
  return applyRunEvents(applyRunState(state, runId, "transpiling"), runId, events);
}

describe("output state", () => {
  test("appends events for the current run", () => {
    const s = withRun("r1", [log("hi"), result(2, "42")]);
    expect(s.entries.map((e) => e.event.kind)).toEqual(["console", "result"]);
    expect(s.stale).toBe(false);
  });

  test("ignores events and states from other runs", () => {
    const s = withRun("r1", [log("hi")]);
    expect(applyRunEvents(s, "old", [log("late")])).toBe(s);
    expect(applyRunState(s, "old", "idle")).toBe(s);
  });

  test("marks previous output stale until the new run produces events", () => {
    const first = withRun("r1", [log("one")]);
    const starting = applyRunState(first, "r2", "transpiling");
    expect(starting.stale).toBe(true);
    expect(starting.entries).toHaveLength(1);
    const next = applyRunEvents(starting, "r2", [log("two")]);
    expect(next.stale).toBe(false);
    expect(next.entries.map((e) => (e.event as { args: { v: string }[] }).args[0]?.v)).toEqual(["two"]);
  });

  test("keeps the previous output dimmed when the new run fails to compile", () => {
    const first = withRun("r1", [log("one")]);
    const failed = withRun("r2", [transpileError()], first);
    expect(failed.stale).toBe(true);
    expect(failed.entries.map((e) => e.event.kind)).toEqual(["console", "error"]);
    const failedAgain = withRun("r3", [transpileError()], failed);
    expect(failedAgain.entries.map((e) => e.event.kind)).toEqual(["console", "error"]);
  });

  test("clears stale output when a run evaluates without output", () => {
    const first = withRun("r1", [log("one")]);
    const s = applyRunState(applyRunState(first, "r2", "transpiling"), "r2", "evaluating");
    expect(s.entries).toEqual([]);
    expect(s.stale).toBe(false);
  });

  test("updates a pending promise result in place", () => {
    const pending: RunEvent = {
      kind: "result",
      line: 1,
      source: "autolog",
      value: { t: "promise", id: 1, state: "pending" },
      seq: 100,
      t: 0,
    };
    const settled: RunEvent = {
      kind: "promiseSettled",
      ref: 100,
      value: { t: "promise", id: 1, state: "fulfilled", value: { t: "number", v: "7" } },
      seq: 101,
      t: 0,
    };
    const s = withRun("r1", [pending, settled]);
    expect(s.entries).toHaveLength(1);
    expect(s.entries[0]?.event).toMatchObject({ value: { state: "fulfilled" } });
  });

  test("console.clear empties the panel and truncation is tracked", () => {
    const clear: RunEvent = { kind: "console", level: "clear", groupDepth: 0, args: [], seq: ++seq, t: 0 };
    const s = withRun("r1", [log("a"), clear, log("b"), { kind: "truncated", dropped: 40, seq: ++seq, t: 0 }]);
    expect(s.entries).toHaveLength(1);
    expect(s.truncated).toBe(40);
  });

  test("hides undefined results unless Show Undefined is on", () => {
    const undef: RunEvent = { kind: "result", line: 1, source: "autolog", value: { t: "undefined" }, seq: ++seq, t: 0 };
    const s = withRun("r1", [undef, result(2, "1")]);
    expect(visibleEntries(s, { showUndefined: false })).toHaveLength(1);
    expect(visibleEntries(s, { showUndefined: true })).toHaveLength(2);
  });

  // Task 13 (spec §5.12): alert() events are queued separately, never as a console-output row.
  test("dialog events are queued for WebDialog, not appended to entries", () => {
    const dialog: RunEvent = { kind: "dialog", text: "hi from the page", seq: ++seq, t: 0 };
    const s = withRun("r1", [log("before"), dialog, log("after")]);
    expect(s.entries.map((e) => e.event.kind)).toEqual(["console", "console"]);
    expect(s.dialogs).toEqual([{ key: `r1:${dialog.seq}`, text: "hi from the page" }]);
  });

  test("a new run clears any dialog left over from the previous one", () => {
    const dialog: RunEvent = { kind: "dialog", text: "still open", seq: ++seq, t: 0 };
    const s = withRun("r1", [dialog]);
    expect(s.dialogs).toHaveLength(1);
    const next = applyRunState(s, "r2", "transpiling");
    expect(next.dialogs).toEqual([]);
  });

  test("dismissWebDialog removes one dialog by key and leaves the rest", () => {
    const a: RunEvent = { kind: "dialog", text: "a", seq: ++seq, t: 0 };
    const b: RunEvent = { kind: "dialog", text: "b", seq: ++seq, t: 0 };
    const s = withRun("r1", [a, b]);
    const keyA = s.dialogs[0]?.key as string;
    const next = dismissWebDialog(s, keyA);
    expect(next.dialogs).toEqual([{ key: `r1:${b.seq}`, text: "b" }]);
    // Dismissing an already-gone key is a no-op, returning the identical object rather than a new one.
    expect(dismissWebDialog(next, keyA)).toBe(next);
  });
});
