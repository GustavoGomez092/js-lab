import { describe, expect, mock, test } from "bun:test";
import { DIALOG_WARNING, type DialogGlobal, installDialogShim } from "../src/dialogs";

function setup() {
  const pushed: { kind: "dialog"; text: string }[] = [];
  const warn = mock((_text: string) => {});
  const g: DialogGlobal = { console: { warn } };
  const handle = installDialogShim({ global: g, sink: { push: (body) => pushed.push(body) } });
  return { g, pushed, warn, handle };
}

describe("installDialogShim", () => {
  test("alert shows JSLab's own non-blocking dialog and returns immediately", () => {
    const { g, pushed } = setup();
    const returned = g.alert?.("hello");
    expect(returned).toBeUndefined();
    expect(pushed).toEqual([{ kind: "dialog", text: "hello" }]);
  });

  test("alert with no message stringifies like the platform's own alert()", () => {
    const { g, pushed } = setup();
    g.alert?.();
    expect(pushed).toEqual([{ kind: "dialog", text: "undefined" }]);
  });

  test("confirm always answers false, without showing anything", () => {
    const { g, pushed } = setup();
    expect(g.confirm?.("Really?")).toBe(false);
    expect(pushed).toEqual([]);
  });

  test("prompt always answers null, without showing anything", () => {
    const { g, pushed } = setup();
    expect(g.prompt?.("Name?", "default")).toBeNull();
    expect(pushed).toEqual([]);
  });

  test("warns once per run across all three functions, not once per call", () => {
    const { g, warn } = setup();
    g.alert?.("a");
    g.alert?.("b");
    g.confirm?.("c");
    g.prompt?.("d");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(DIALOG_WARNING);
  });

  test("the once-per-run warning resets when a new run starts", () => {
    const { g, warn, handle } = setup();
    g.alert?.("a");
    expect(warn).toHaveBeenCalledTimes(1);
    handle.startRun();
    g.confirm?.("b");
    expect(warn).toHaveBeenCalledTimes(2);
  });

  test("installs against the real global by default", () => {
    const pushed: { kind: "dialog"; text: string }[] = [];
    const fakeGlobal = globalThis as unknown as DialogGlobal;
    const original = { alert: fakeGlobal.alert, confirm: fakeGlobal.confirm, prompt: fakeGlobal.prompt };
    installDialogShim({ sink: { push: (body) => pushed.push(body) } });
    try {
      expect((globalThis as unknown as DialogGlobal).confirm?.("x")).toBe(false);
    } finally {
      Object.assign(globalThis, original);
    }
  });
});
