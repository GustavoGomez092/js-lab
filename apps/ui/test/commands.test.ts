import { describe, expect, mock, test } from "bun:test";
import { COMMANDS, createTab, defaultSession, defaultSettings } from "@jslab/shared";
import { createEditorCommands, EDITOR_ACTIONS } from "../src/commands/editor-commands";
import { CommandRegistry } from "../src/commands/registry";
import { sortLinesCaseInsensitive, toggleMagicCommentLines } from "../src/commands/text-edits";
import type { EditorHandle } from "../src/editor/editor-handle";
import { createAppStore } from "../src/state/store";
import { createTabActions } from "../src/tabs/tab-actions";
import { createFakeApi } from "./fake-api";

describe("CommandRegistry", () => {
  test("executes known enabled commands, reports unknown and disabled ones, and replaces on re-register", () => {
    const registry = new CommandRegistry();
    const first = mock(() => {});
    const second = mock(() => {});
    registry.register({ id: "run.start", run: first });
    registry.register({ id: "run.start", run: second }, { id: "run.stop", run: () => {}, isEnabled: () => false });
    expect(registry.execute("run.start")).toBe("executed");
    expect(registry.execute("run.stop")).toBe("disabled");
    expect(registry.execute("nope")).toBe("unknown");
    expect([first.mock.calls.length, second.mock.calls.length]).toEqual([0, 1]);
    expect(registry.list().map((spec) => spec.id)).toEqual(["run.start", "run.stop"]);
  });

  test("sync throws and async rejections go to onError", async () => {
    const errors: string[] = [];
    const registry = new CommandRegistry((id, error) => errors.push(`${id}:${String(error)}`));
    registry.register(
      {
        id: "run.kill",
        run: () => {
          throw new Error("sync");
        },
      },
      { id: "tab.new", run: async () => Promise.reject(new Error("async")) },
    );
    expect(registry.execute("run.kill")).toBe("executed");
    registry.execute("tab.new");
    await Bun.sleep(0);
    expect(errors).toEqual(["run.kill:Error: sync", "tab.new:Error: async"]);
  });
});

describe("text edits", () => {
  test("toggle magic comments on non-empty lines, removing them only when every line has one", () => {
    expect(toggleMagicCommentLines(["a", "", "b //?"])).toEqual(["a //?", "", "b //?"]);
    expect(toggleMagicCommentLines(["a //?", "  b //? $.length"])).toEqual(["a", "  b"]);
    expect(toggleMagicCommentLines([""])).toEqual([""]);
    expect(toggleMagicCommentLines(["url //?x"])).toEqual(["url //?x //?"]);
  });

  test("sort lines case-insensitively, optionally reversed", () => {
    expect(sortLinesCaseInsensitive(["b", "A", "c", "a"], false)).toEqual(["A", "a", "b", "c"]);
    expect(sortLinesCaseInsensitive(["b", "A", "c"], true)).toEqual(["c", "b", "A"]);
  });
});

describe("editor commands", () => {
  const fakeHandle = (value: string, range: { startLine: number; endLine: number }) => {
    let lines = value.split("\n");
    const handle = {
      runAction: mock((_id: string) => true),
      getSelectedLineRange: () => range,
      getValue: () => lines.join("\n"),
      getLines: (start: number, end: number) => lines.slice(start - 1, end),
      replaceLines: mock((start: number, end: number, next: string[]) => {
        lines = [...lines.slice(0, start - 1), ...next, ...lines.slice(end)];
      }),
    };
    return handle as typeof handle & EditorHandle;
  };

  test("every editor command in the catalogue is implemented", () => {
    const implemented = new Set(createEditorCommands(() => null).map((spec) => spec.id));
    const expected = COMMANDS.filter((c) => c.id.startsWith("edit.")).map((c) => c.id);
    expect(expected.filter((id) => !implemented.has(id))).toEqual([]);
    expect(Object.values(EDITOR_ACTIONS)).toContain("editor.action.marker.next");
  });

  test("actions run through the handle, and line edits replace only what changed", () => {
    const handle = fakeHandle("b\nA\nc //?", { startLine: 2, endLine: 2 });
    const specs = new Map(createEditorCommands(() => handle).map((spec) => [spec.id, spec]));
    specs.get("edit.duplicateLine")?.run();
    expect(handle.runAction).toHaveBeenCalledWith("editor.action.copyLinesDownAction");
    specs.get("edit.toggleMagicComment")?.run();
    expect(handle.getValue()).toBe("b\nA //?\nc //?");
    specs.get("edit.sortLinesCaseInsensitive")?.run();
    expect(handle.getValue()).toBe("A //?\nb\nc //?");
    expect(createEditorCommands(() => null)[0]?.isEnabled?.()).toBe(false);
  });
});

// Carried item T11-m4: tab actions must not `void` their promises. A rejected Main call reports a status
// message through the store and leaves the store's tab state exactly as it was.
describe("tab actions: error handling (T11-m4)", () => {
  function setup() {
    const store = createAppStore();
    store.getState().hydrate({
      settings: defaultSettings(),
      session: defaultSession(() => createTab({ id: "t1" })),
      buffers: { t1: "1 + 1" },
      safeMode: { active: false, reason: null },
      versions: { app: "0.0.1", bun: "1.3.13" },
    });
    const { api } = createFakeApi();
    return { store, api, tabs: createTabActions(store, api) };
  }

  test("a rejected closeTab sets a status message and keeps the tab", async () => {
    const { store, api, tabs } = setup();
    api.closeTab.mockImplementation(async () => {
      throw new Error("EACCES");
    });
    const closed = await tabs.close("t1");
    expect(closed).toBe(false);
    expect(store.getState().tabs.t1).toBeDefined();
    expect(store.getState().tabOrder).toEqual(["t1"]);
    expect(store.getState().statusMessage).toContain("EACCES");
  });

  // m-3: the same guard covers createTab and reopenTab, not just closeTab.
  test("a rejected createTab and a rejected reopenTab each set a status message and leave tab state unchanged", async () => {
    const { store, api, tabs } = setup();
    api.createTab.mockImplementation(async () => {
      throw new Error("disk full");
    });
    await tabs.newTab();
    expect(store.getState().tabOrder).toEqual(["t1"]);
    expect(store.getState().statusMessage).toContain("disk full");

    store.getState().setStatusMessage(null);
    api.reopenTab.mockImplementation(async () => {
      throw new Error("ENOENT");
    });
    await tabs.reopen();
    expect(store.getState().tabOrder).toEqual(["t1"]);
    expect(store.getState().closedCount).toBe(0);
    expect(store.getState().statusMessage).toContain("ENOENT");
  });
});

// Carried item T11-oos1: `tab.reopenClosed` must not drift closedCount when Main's result is stale or
// duplicated. Two rapid reopen calls that both resolve the same tab must apply it only once.
describe("tab actions: reopen dedup (T11-oos1)", () => {
  test("two rapid reopenClosed calls returning the same tab decrement closedCount once and keep one tab", async () => {
    const store = createAppStore();
    store.getState().hydrate({
      settings: defaultSettings(),
      session: defaultSession(() => createTab({ id: "t1" })),
      buffers: { t1: "1 + 1" },
      safeMode: { active: false, reason: null },
      versions: { app: "0.0.1", bun: "1.3.13" },
    });
    store.getState().setClosedCount(2);
    const { api } = createFakeApi();
    const reopenedTab = createTab({ id: "t2" });
    api.reopenTab.mockImplementation(async () => ({ tab: reopenedTab, content: "2 + 2" }));
    const tabs = createTabActions(store, api);
    await Promise.all([tabs.reopen(), tabs.reopen()]);
    expect(store.getState().closedCount).toBe(1);
    expect(store.getState().tabOrder.filter((id) => id === "t2")).toHaveLength(1);
  });
});
