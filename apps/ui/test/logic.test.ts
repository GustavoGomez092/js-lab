import { describe, expect, mock, test } from "bun:test";
import type { BootstrapPayload, EncodedValue, RunEvent } from "@jslab/rpc-schema";
import { createTab, defaultSession, defaultSettings } from "@jslab/shared";
import { markersFor } from "../src/editor/markers";
import { keyLabel } from "../src/output/format";
import { entryToText, valueToText } from "../src/output/text";
import { commandForKey } from "../src/shell/keys";
import { startAutoRun, type TimerApi } from "../src/state/auto-run";
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
});

describe("commandForKey", () => {
  const key = (
    code: string,
    mods: Partial<{ metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }> = {},
  ) => ({
    code,
    metaKey: true,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...mods,
  });

  test("maps the M1 shortcuts", () => {
    expect(commandForKey(key("KeyR"))).toBe("run.start");
    expect(commandForKey(key("KeyR", { shiftKey: true }))).toBe("run.stop");
    expect(commandForKey(key("KeyR", { altKey: true }))).toBe("run.kill");
    expect(commandForKey(key("KeyK"))).toBe("output.clear");
  });

  test("ignores keys without Cmd or with Ctrl", () => {
    expect(commandForKey(key("KeyR", { metaKey: false }))).toBeNull();
    expect(commandForKey(key("KeyR", { ctrlKey: true }))).toBeNull();
    expect(commandForKey(key("KeyX"))).toBeNull();
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
  });
});
