import { describe, expect, mock, test } from "bun:test";
import type { BootstrapPayload, EncodedValue, RunEvent } from "@jslab/rpc-schema";
import { createTab, defaultSession, defaultSettings } from "@jslab/shared";
import { createMarkerTracker, markersFor } from "../src/editor/markers";
import { keyLabel } from "../src/output/format";
import { entryToText, valueToText } from "../src/output/text";
import { startAutoRun, type TimerApi } from "../src/state/auto-run";
import {
  createEventCoalescer,
  createFrameScheduler,
  FLUSH_TIMEOUT_MS,
  MAX_QUEUED_EVENTS,
} from "../src/state/event-coalescer";
import { applyRunEvents, applyRunState, initialOutput } from "../src/state/output";
import { createAppStore } from "../src/state/store";

function manualTimers() {
  let next = 1;
  const pending = new Map<number, { callback: () => void; ms: number }>();
  const timers: TimerApi = {
    setTimeout: (callback, ms) => {
      const id = next++;
      pending.set(id, { callback, ms });
      return id;
    },
    clearTimeout: (id) => {
      pending.delete(id as number);
    },
  };
  const fireAll = () => {
    for (const [id, { callback }] of [...pending]) {
      pending.delete(id);
      callback();
    }
  };
  return { timers, pending, fireAll };
}

function hydratedStore(safe = false) {
  const store = createAppStore();
  const payload: BootstrapPayload = {
    settings: defaultSettings(),
    session: defaultSession(() => createTab({ id: "t1" })),
    buffers: { t1: "1" },
    safeMode: safe ? { active: true, reason: "shift" } : { active: false, reason: null },
    versions: { app: "0.0.1", bun: "1.3.13" },
  };
  store.getState().hydrate(payload);
  return store;
}

describe("startAutoRun", () => {
  test("debounces edits into one run after the configured delay", () => {
    const store = hydratedStore();
    const run = mock(() => {});
    const clock = manualTimers();
    startAutoRun(store, run, clock.timers);
    store.getState().editCode("1 +");
    store.getState().editCode("1 + 2");
    expect(clock.pending.size).toBe(1);
    expect([...clock.pending.values()][0]?.ms).toBe(300);
    clock.fireAll();
    expect(run).toHaveBeenCalledTimes(1);
  });

  test("does not run restored code or anything in safe mode", () => {
    const run = mock(() => {});
    const clock = manualTimers();
    const store = createAppStore();
    startAutoRun(store, run, clock.timers);
    store.getState().hydrate({
      settings: defaultSettings(),
      session: defaultSession(() => createTab({ id: "t1" })),
      buffers: { t1: "while (true) {}" },
      safeMode: { active: false, reason: null },
      versions: { app: "0", bun: "0" },
    });
    expect(clock.pending.size).toBe(0);

    const safe = hydratedStore(true);
    startAutoRun(safe, run, clock.timers);
    safe.getState().editCode("2");
    expect(clock.pending.size).toBe(0);
    expect(run).not.toHaveBeenCalled();
  });

  test("changing the language of an armed tab schedules a run", () => {
    const store = hydratedStore();
    const run = mock(() => {});
    const clock = manualTimers();
    startAutoRun(store, run, clock.timers);
    store.getState().armAutoRun();
    store.getState().setLanguage("javascript");
    clock.fireAll();
    expect(run).toHaveBeenCalledTimes(1);
  });

  test("switching a tab's runtime schedules a run on its own, without a prior edit arming it (spec §5.2)", () => {
    const store = hydratedStore();
    const run = mock(() => {});
    const clock = manualTimers();
    startAutoRun(store, run, clock.timers);
    // Unlike a language change, a runtime change is armed by the switch itself (store.ts's setRuntime) -- the spec
    // states it as unconditional ("a change triggers a run when Auto Run is on"), not gated on the tab already
    // being dirty from an edit.
    store.getState().setRuntime("browser");
    expect(clock.pending.size).toBe(1);
    clock.fireAll();
    expect(run).toHaveBeenCalledTimes(1);
  });

  test("switching a tab's runtime in Safe Mode never schedules a run", () => {
    const run = mock(() => {});
    const clock = manualTimers();
    const safe = hydratedStore(true);
    startAutoRun(safe, run, clock.timers);
    safe.getState().setRuntime("browser");
    expect(clock.pending.size).toBe(0);
    expect(run).not.toHaveBeenCalled();
  });

  test("unsubscribing cancels a pending run", () => {
    const store = hydratedStore();
    const run = mock(() => {});
    const clock = manualTimers();
    const stop = startAutoRun(store, run, clock.timers);
    store.getState().editCode("3");
    stop();
    clock.fireAll();
    expect(run).not.toHaveBeenCalled();
  });

  // Fix round 1 (I-1): a caller that already covers a pending edit (for example a manual run that just
  // formatted the code) needs to cancel the timer that edit armed, without tearing down the subscription.
  test("cancelPending stops a scheduled run without unsubscribing", () => {
    const store = hydratedStore();
    const run = mock(() => {});
    const clock = manualTimers();
    const stop = startAutoRun(store, run, clock.timers);
    store.getState().editCode("1 + 2");
    expect(clock.pending.size).toBe(1);
    stop.cancelPending();
    expect(clock.pending.size).toBe(0);
    clock.fireAll();
    expect(run).not.toHaveBeenCalled();
    // Still subscribed: a later edit can schedule again.
    store.getState().editCode("1 + 3");
    expect(clock.pending.size).toBe(1);
    clock.fireAll();
    expect(run).toHaveBeenCalledTimes(1);
  });

  test("a pending auto-run does not fire once the guard no longer holds", () => {
    // Case A: Safe Mode engages during the debounce window.
    const store = hydratedStore();
    const run = mock(() => {});
    const clock = manualTimers();
    startAutoRun(store, run, clock.timers);
    store.getState().editCode("1 + 2");
    expect(clock.pending.size).toBe(1);
    store.setState({ safeMode: { active: true, reason: "crashLoop" } });
    clock.fireAll();
    expect(run).not.toHaveBeenCalled();

    // Case B: hydrate() disarms auto-run during the debounce window.
    const store2 = hydratedStore();
    const run2 = mock(() => {});
    const clock2 = manualTimers();
    startAutoRun(store2, run2, clock2.timers);
    store2.getState().editCode("1 + 2");
    expect(clock2.pending.size).toBe(1);
    store2.getState().hydrate({
      settings: defaultSettings(),
      session: defaultSession(() => createTab({ id: "t1" })),
      buffers: { t1: "1" },
      safeMode: { active: false, reason: null },
      versions: { app: "0.0.1", bun: "1.3.13" },
    });
    clock2.fireAll();
    expect(run2).not.toHaveBeenCalled();
  });

  test("switching tabs never schedules a run, and cancels a debounce pending for the tab being left", () => {
    const store = hydratedStore();
    const run = mock(() => {});
    const clock = manualTimers();
    startAutoRun(store, run, clock.timers);
    store.getState().editCode("1 +");
    clock.fireAll();
    store.getState().openTab(createTab({ id: "t2" }), "2 + 2", false);
    store.getState().activateTab("t2");
    store.getState().activateTab("t1");
    expect(clock.pending.size).toBe(0);
    store.getState().editCode("1 + 2");
    expect(clock.pending.size).toBe(1);
    store.getState().activateTab("t2");
    expect(clock.pending.size).toBe(0);
    clock.fireAll();
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("markersFor", () => {
  const runtimeError: RunEvent = {
    kind: "error",
    phase: "runtime",
    name: "Error",
    message: "boom",
    line: 3,
    column: 7,
    stack: [],
    seq: 1,
    t: 0,
  };
  const syntaxError: RunEvent = {
    kind: "error",
    phase: "transpile",
    name: "SyntaxError",
    message: "Unexpected token",
    line: 1,
    column: 11,
    stack: [],
    seq: 1,
    t: 0,
  };

  test("marks transform warnings and runtime errors", () => {
    const output = applyRunEvents(applyRunState(initialOutput, "r1", "transpiling"), "r1", [runtimeError]);
    const markers = markersFor(
      [
        {
          severity: "warning",
          code: "magic-comment-no-value",
          message: "Magic comment has no value to log",
          line: 2,
          column: 5,
        },
      ],
      output,
    );
    expect(markers.map((m) => [m.severity, m.startLineNumber, m.source])).toEqual([
      ["warning", 2, "jslab"],
      ["error", 3, "runtime"],
    ]);
  });

  test("keeps syntax errors but drops stale runtime errors", () => {
    const first = applyRunEvents(applyRunState(initialOutput, "r1", "transpiling"), "r1", [runtimeError]);
    const failed = applyRunEvents(applyRunState(first, "r2", "transpiling"), "r2", [{ ...syntaxError, seq: 2 }]);
    expect(markersFor([], failed).map((m) => m.source)).toEqual(["syntax"]);
  });
});

describe("text rendering", () => {
  const num = (v: string): EncodedValue => ({ t: "number", v });

  test("renders nested values on one line", () => {
    const value: EncodedValue = {
      t: "object",
      id: 1,
      ctor: "Object",
      props: [
        [{ k: "a" }, num("1")],
        [
          { k: "list" },
          {
            t: "array",
            id: 2,
            ctor: "Array",
            length: 2,
            items: [
              [0, { t: "string", v: "x" }],
              [1, num("2")],
            ],
          },
        ],
      ],
    };
    expect(valueToText(value)).toBe('{ a: 1, list: ["x", 2] }');
    expect(valueToText({ t: "string", v: "top" })).toBe("top");
    // Copy All used to produce an empty line for a logged DOM node, because nothing summarised it (spec §5.9).
    expect(
      valueToText({
        t: "dom",
        nodeType: 1,
        tag: "DIV",
        attrs: [["id", "app"]],
        childCount: 2,
        outerHTML: '<div id="app"></div>',
      }),
    ).toBe('<div id="app"> (2 children)');
  });

  test("renders console arguments, streams and errors", () => {
    expect(
      entryToText({
        kind: "console",
        level: "log",
        groupDepth: 0,
        args: [{ t: "string", v: "n" }, num("3")],
        seq: 1,
        t: 0,
      }),
    ).toBe("n 3");
    expect(entryToText({ kind: "stdout", text: "raw\n", seq: 1, t: 0 })).toBe("raw");
    expect(
      entryToText({
        kind: "error",
        phase: "runtime",
        name: "Error",
        message: "boom",
        stack: [{ fn: "f", line: 3, column: 2, user: true }],
        seq: 1,
        t: 0,
      }),
    ).toBe("Error: boom\n    at f (L3:2)");
  });
});

describe("keyLabel", () => {
  test("quotes keys that are not identifiers", () => {
    expect(keyLabel({ k: "name" })).toBe("name");
    expect(keyLabel({ k: "foo bar" })).toBe('"foo bar"');
    expect(keyLabel({ k: "foo-bar" })).toBe('"foo-bar"');
    expect(keyLabel({ k: "" })).toBe('""');
    expect(keyLabel({ k: "_$ok1" })).toBe("_$ok1");
    expect(keyLabel({ k: "1abc" })).toBe('"1abc"');
    expect(keyLabel({ k: "café" })).toBe("café");
    expect(keyLabel({ k: "π" })).toBe("π");
  });
});

describe("marker tracker (final review M12)", () => {
  const runtimeError = (line: number, seq: number): RunEvent => ({
    kind: "error",
    phase: "runtime",
    name: "Error",
    message: "boom",
    line,
    column: 1,
    stack: [],
    seq,
    t: 0,
  });
  const consoleLog = (seq: number): RunEvent => ({ kind: "console", level: "log", groupDepth: 0, args: [], seq, t: 0 });

  test("matches markersFor, scans only appended entries, and reports no change when nothing relevant arrived", () => {
    const tracker = createMarkerTracker();
    const diagnostics = [
      { severity: "warning" as const, code: "magic-comment-no-value", message: "m", line: 1, column: 1 },
    ];
    let output = applyRunState(initialOutput, "r1", "transpiling");
    output = applyRunEvents(output, "r1", [runtimeError(2, 1)]);
    expect(tracker.update(diagnostics, output)).toEqual(markersFor(diagnostics, output));
    expect(tracker.update(diagnostics, output)).toBeNull();
    output = applyRunEvents(output, "r1", [consoleLog(2)]);
    expect(tracker.update(diagnostics, output)).toBeNull();
    output = applyRunEvents(output, "r1", [runtimeError(5, 3)]);
    expect(tracker.update(diagnostics, output)).toEqual(markersFor(diagnostics, output));
    const next = applyRunState(output, "r2", "transpiling");
    expect(tracker.update([], next)).toEqual(markersFor([], next));
  });
});

describe("event coalescer (final review M12, T15)", () => {
  const consoleLog = (seq: number): RunEvent => ({ kind: "console", level: "log", groupDepth: 0, args: [], seq, t: 0 });

  test("merges batches per tab and run into one apply per frame, and flushes a tab on demand", () => {
    const applied: [string, string, number][] = [];
    const frames: (() => void)[] = [];
    const coalescer = createEventCoalescer(
      (tabId, runId, events) => applied.push([tabId, runId, events.length]),
      (callback) => frames.push(callback),
    );
    coalescer.push("a", "r1", [consoleLog(1)]);
    coalescer.push("a", "r1", [consoleLog(2), consoleLog(3)]);
    coalescer.push("b", "r9", [consoleLog(1)]);
    expect([frames.length, applied]).toEqual([1, []]);
    coalescer.flush("b");
    expect(applied).toEqual([["b", "r9", 1]]);
    frames[0]?.();
    expect(applied).toEqual([
      ["b", "r9", 1],
      ["a", "r1", 3],
    ]);
    coalescer.push("a", "r1", [consoleLog(4)]);
    coalescer.push("a", "r2", [consoleLog(1)]);
    frames[1]?.();
    expect(applied.slice(2)).toEqual([
      ["a", "r1", 1],
      ["a", "r2", 1],
    ]);
  });

  // FB-I1: WebKit suspends rAF for a hidden window, so a frame may never come. A tab's queue must stay bounded and
  // its entries must still reach the store.
  test("with a scheduler that never fires, a tab's queue stays bounded and its entries still reach the store (FB-I1)", () => {
    const applied: number[] = [];
    const coalescer = createEventCoalescer(
      (_tabId, _runId, events) => applied.push(events.length),
      () => {},
    );
    let seq = 0;
    for (let batch = 0; batch < 100; batch++) {
      coalescer.push(
        "a",
        "r1",
        Array.from({ length: 200 }, () => consoleLog(++seq)),
      );
    }
    const delivered = applied.reduce((sum, count) => sum + count, 0);
    expect(delivered).toBeGreaterThanOrEqual(20_000 - MAX_QUEUED_EVENTS);
    expect(Math.max(...applied)).toBeLessThanOrEqual(MAX_QUEUED_EVENTS + 200);
    coalescer.flush();
    expect(applied.reduce((sum, count) => sum + count, 0)).toBe(20_000);
  });

  test("the frame scheduler runs its callback once: on the frame, or after the timeout when no frame comes (FB-I1)", () => {
    const frames: (() => void)[] = [];
    const timers = new Map<number, () => void>();
    let nextTimer = 1;
    const schedule = createFrameScheduler({
      requestFrame: (callback) => frames.push(callback),
      setTimeout: (callback, ms) => {
        expect(ms).toBe(FLUSH_TIMEOUT_MS);
        timers.set(nextTimer, callback);
        return nextTimer++;
      },
      clearTimeout: (handle) => timers.delete(handle as number),
    });
    const runs = mock(() => {});

    schedule(runs);
    frames.shift()?.();
    expect([runs.mock.calls.length, timers.size]).toEqual([1, 0]);

    schedule(runs);
    const [timer] = [...timers.values()];
    timer?.();
    frames.shift()?.();
    expect(runs.mock.calls.length).toBe(2);
  });

  // RR2-m6: no dispose meant a pending frame/timeout callback could still fire after App unmounted or the
  // coalescer was rebuilt, and apply queued events to a surviving store with no way to stop it.
  test("dispose() clears pending queues and makes an already-scheduled callback apply nothing", () => {
    const applied: number[] = [];
    const frames: (() => void)[] = [];
    const coalescer = createEventCoalescer(
      (_tabId, _runId, events) => applied.push(events.length),
      (callback) => frames.push(callback),
    );
    coalescer.push("a", "r1", [consoleLog(1)]);
    coalescer.push("b", "r9", [consoleLog(2)]);
    expect(frames.length).toBe(1);
    coalescer.dispose();
    // The scheduler's callback still fires (nothing can force-cancel a real rAF/timeout from here), but it must
    // find no queued work and apply nothing.
    frames[0]?.();
    expect(applied).toEqual([]);
    // A flush after dispose is also a no-op: the queues were cleared.
    coalescer.flush();
    expect(applied).toEqual([]);
  });
});
