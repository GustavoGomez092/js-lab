import { describe, expect, mock, test } from "bun:test";
import type { RunEvent } from "@jslab/rpc-schema";
import { createTab, defaultSession, defaultSettings } from "@jslab/shared";
import { createE2EAgent } from "../src/e2e/agent";
import { keyEventInit } from "../src/e2e/keys";
import type { EditorHandle } from "../src/editor/editor-handle";
import { createAppStore } from "../src/state/store";

function setup(editor: Pick<EditorHandle, "typeText"> | null = null) {
  const store = createAppStore();
  store.getState().hydrate({
    settings: defaultSettings(),
    // A custom title, so the snapshot title stays "scratch" after Task 11 derives titles from code (review I3).
    session: defaultSession(() => createTab({ id: "t1", title: "scratch", titleIsCustom: true })),
    buffers: { t1: "1 + 1" },
    safeMode: { active: false, reason: null },
    versions: { app: "0.0.1", bun: "1.4.0" },
  });
  const executeCommand = mock((id: string) => id === "run.start");
  const target = new EventTarget();
  const agent = createE2EAgent({ store, executeCommand, editor: () => editor, target: () => target });
  return { store, agent, executeCommand, target };
}

describe("E2E agent", () => {
  test("state returns a tab-shaped snapshot of the store", async () => {
    const { agent } = setup();
    expect(await agent("state", {})).toMatchObject({
      ready: true,
      activeTabId: "t1",
      tabOrder: ["t1"],
      tabs: [{ id: "t1", title: "scratch", code: "1 + 1", runState: null, entryCount: 0, autoRunArmed: false }],
    });
  });

  test("output renders visible entries as text with their lines", async () => {
    const { agent, store } = setup();
    const result: RunEvent = {
      kind: "result",
      line: 1,
      source: "autolog",
      value: { t: "number", v: "2" },
      seq: 1,
      t: 0,
    };
    store.getState().receiveState("r1", "transpiling");
    store.getState().receiveEvents("r1", [result]);
    expect(await agent("output", {})).toEqual({ entries: [{ kind: "result", line: 1, text: "2" }] });
  });

  test("command executes known ids and rejects unknown ones", async () => {
    const { agent, executeCommand } = setup();
    expect(await agent("command", { id: "run.start" })).toEqual({ executed: "run.start" });
    await expect(agent("command", { id: "nope" })).rejects.toThrow("Unknown command: nope");
    expect(executeCommand).toHaveBeenCalledTimes(2);
  });

  test("key dispatches keydown and keyup with modifiers to the focus target", async () => {
    const { agent, target } = setup();
    const seen: string[] = [];
    target.addEventListener("keydown", (event) => {
      const e = event as KeyboardEvent;
      seen.push(`${e.type}:${e.code}:${e.metaKey}:${e.shiftKey}`);
      e.preventDefault();
    });
    target.addEventListener("keyup", (event) => seen.push(`${event.type}:${(event as KeyboardEvent).code}`));
    expect(await agent("key", { key: "cmd+shift+r" })).toEqual({ defaultPrevented: true });
    expect(seen).toEqual(["keydown:KeyR:true:true", "keyup:KeyR"]);
  });

  test("type delegates to the mounted editor and fails without one", async () => {
    const typeText = mock((_text: string, _replace: boolean) => {});
    const withEditor = setup({ typeText });
    expect(await withEditor.agent("type", { text: "2 + 2", replace: true })).toEqual({ typed: 5 });
    expect(typeText).toHaveBeenCalledWith("2 + 2", true);
    await expect(setup(null).agent("type", { text: "x" })).rejects.toThrow("No editor is mounted");
  });
});

describe("keyEventInit", () => {
  test("maps key specs to KeyboardEvent codes and rejects unknown parts", () => {
    expect(keyEventInit("cmd+=")).toMatchObject({ code: "Equal", metaKey: true, shiftKey: false });
    expect(keyEventInit("ctrl+shift+tab")).toMatchObject({ code: "Tab", ctrlKey: true, shiftKey: true });
    expect(keyEventInit("f9")).toMatchObject({ code: "F9", metaKey: false });
    expect(keyEventInit("alt+cmd+1")).toMatchObject({ code: "Digit1", altKey: true, metaKey: true });
    expect(() => keyEventInit("hyper+r")).toThrow(/Unknown modifier/);
    expect(() => keyEventInit("cmd+pagedown")).toThrow(/Unknown key/);
  });
});
