import { describe, expect, test } from "bun:test";
import type { BootstrapPayload, RunEvent } from "@jslab/rpc-schema";
import { createTab, defaultSession, defaultSettings, mergeSettings } from "@jslab/shared";
import { createAppStore, shouldAutoRun } from "../src/state/store";

function payload(overrides: Partial<BootstrapPayload> = {}): BootstrapPayload {
  return {
    settings: defaultSettings(),
    session: defaultSession(() => createTab({ id: "t1", title: "scratch" })),
    buffers: { t1: "1 + 1" },
    safeMode: { active: false, reason: null },
    versions: { app: "0.0.1", bun: "1.3.13" },
    ...overrides,
  };
}

const log = (seq: number): RunEvent => ({ kind: "console", level: "log", groupDepth: 0, args: [], seq, t: 0 });

describe("app store", () => {
  test("hydrate loads the active tab and its buffer without arming auto-run", () => {
    const store = createAppStore();
    store.getState().hydrate(payload());
    const s = store.getState();
    expect(s.ready).toBe(true);
    expect(s.tab?.id).toBe("t1");
    expect(s.code).toBe("1 + 1");
    expect(s.autoRunArmed).toBe(false);
    expect(shouldAutoRun(s)).toBe(false);
  });

  test("the first edit arms auto-run", () => {
    const store = createAppStore();
    store.getState().hydrate(payload());
    store.getState().editCode("2 + 2");
    expect(store.getState().code).toBe("2 + 2");
    expect(shouldAutoRun(store.getState())).toBe(true);
  });

  test("auto-run stays off in safe mode and when disabled in settings", () => {
    const safe = createAppStore();
    safe.getState().hydrate(payload({ safeMode: { active: true, reason: "crashLoop" } }));
    safe.getState().editCode("x");
    expect(shouldAutoRun(safe.getState())).toBe(false);

    const disabled = createAppStore();
    disabled.getState().hydrate(payload({ settings: mergeSettings(defaultSettings(), { run: { autoRun: false } }) }));
    disabled.getState().editCode("x");
    expect(shouldAutoRun(disabled.getState())).toBe(false);
  });

  test("run events and states flow through the output reducer", () => {
    const store = createAppStore();
    store.getState().receiveState("r1", "transpiling");
    store.getState().receiveEvents("r1", [log(1), log(2)]);
    store.getState().receiveState("r1", "idle");
    expect(store.getState().output.entries).toHaveLength(2);
    expect(store.getState().output.runState).toBe("idle");
    store.getState().clearOutput();
    expect(store.getState().output.entries).toEqual([]);
  });

  test("diagnostics are kept only for the current run and reset when a new run starts", () => {
    const store = createAppStore();
    const warning = { severity: "warning" as const, code: "magic-comment-no-value", message: "m", line: 1, column: 1 };
    store.getState().receiveState("r1", "transpiling");
    store.getState().receiveDiagnostics("r1", [warning]);
    store.getState().receiveDiagnostics("old", []);
    expect(store.getState().diagnostics).toEqual([warning]);
    store.getState().receiveState("r2", "transpiling");
    expect(store.getState().diagnostics).toEqual([]);
  });

  test("reveal requests carry an increasing nonce so repeated clicks re-trigger", () => {
    const store = createAppStore();
    store.getState().reveal(4);
    store.getState().reveal(4);
    expect(store.getState().revealRequest).toEqual({ line: 4, nonce: 2 });
  });

  test("layout changes are clamped and toggle orientation", () => {
    const store = createAppStore();
    store.getState().hydrate(payload());
    store.getState().setEditorSize(99);
    store.getState().toggleOrientation();
    expect(store.getState().tab?.layout).toEqual({ orientation: "vertical", editorSize: 90 });
  });
});
