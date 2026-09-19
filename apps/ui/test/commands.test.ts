import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { RunEvent } from "@jslab/rpc-schema";
import { COMMANDS, createTab, defaultSession, defaultSettings } from "@jslab/shared";
import { createAppCommands } from "../src/commands/app-commands";
import { createEditorCommands, EDITOR_ACTIONS } from "../src/commands/editor-commands";
import { CommandRegistry } from "../src/commands/registry";
import { sortLinesCaseInsensitive, toggleMagicCommentLines } from "../src/commands/text-edits";
import type { EditorHandle } from "../src/editor/editor-handle";
import { entryToText } from "../src/output/text";
import type { DisplayEvent } from "../src/state/output";
import { createAppStore } from "../src/state/store";
import { strings } from "../src/strings";
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

  const logpointStore = () => {
    const store = createAppStore();
    store.getState().hydrate({
      settings: defaultSettings(),
      session: defaultSession(() => createTab({ id: "t1" })),
      buffers: { t1: "const a = 1\nconst b = 2" },
      safeMode: { active: false, reason: null },
      versions: { app: "0", bun: "1.4.0" },
    });
    return store;
  };

  test("every editor command in the catalogue is implemented", () => {
    const implemented = new Set(createEditorCommands(() => null, logpointStore()).map((spec) => spec.id));
    const expected = COMMANDS.filter((c) => c.id.startsWith("edit.")).map((c) => c.id);
    expect(expected.filter((id) => !implemented.has(id))).toEqual([]);
    expect(Object.values(EDITOR_ACTIONS)).toContain("editor.action.marker.next");
  });

  test("actions run through the handle, and line edits replace only what changed", () => {
    const handle = fakeHandle("b\nA\nc //?", { startLine: 2, endLine: 2 });
    const specs = new Map(createEditorCommands(() => handle, logpointStore()).map((spec) => [spec.id, spec]));
    specs.get("edit.duplicateLine")?.run();
    expect(handle.runAction).toHaveBeenCalledWith("editor.action.copyLinesDownAction");
    specs.get("edit.toggleMagicComment")?.run();
    expect(handle.getValue()).toBe("b\nA //?\nc //?");
    specs.get("edit.sortLinesCaseInsensitive")?.run();
    expect(handle.getValue()).toBe("A //?\nb\nc //?");
    expect(createEditorCommands(() => null, logpointStore())[0]?.isEnabled?.()).toBe(false);
  });

  test("F9's command toggles the cursor's line, and Clear All drops every logpoint (spec §6.3)", () => {
    const store = logpointStore();
    let cursorLine: number | null = 2;
    const handle = { getCursorLine: () => cursorLine } as unknown as EditorHandle;
    const registry = new CommandRegistry();
    registry.register(...createEditorCommands(() => handle, store));

    expect(registry.execute("edit.toggleLogpoint")).toBe("executed");
    expect(store.getState().logpoints).toEqual([2]);
    registry.execute("edit.toggleLogpoint");
    expect(store.getState().logpoints).toEqual([]);

    store.getState().toggleLogpoint(1);
    store.getState().toggleLogpoint(2);
    registry.execute("edit.clearLogpoints");
    expect(store.getState().logpoints).toEqual([]);

    // With no cursor (no editor mounted) the toggle runs but touches nothing, rather than guessing a line.
    cursorLine = null;
    expect(registry.execute("edit.toggleLogpoint")).toBe("executed");
    expect(store.getState().logpoints).toEqual([]);
    // Clear All is offered only when there is something to clear, so the palette greys it out.
    expect(registry.execute("edit.clearLogpoints")).toBe("disabled");
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

describe("M3 app commands", () => {
  function setup(workingDirectory: string | null = null) {
    const store = createAppStore();
    store.getState().hydrate({
      settings: defaultSettings(),
      session: defaultSession(() => createTab({ id: "t1", workingDirectory })),
      buffers: { t1: "" },
      safeMode: { active: false, reason: null },
      versions: { app: "0", bun: "1.4.0" },
    });
    const { api } = createFakeApi();
    const registry = new CommandRegistry();
    registry.register(
      ...createAppCommands({ store, api, tabs: createTabActions(store, api), run: () => {}, editor: () => null }),
    );
    return { store, api, registry };
  }

  test("Tools commands open their sheets", () => {
    const { store, registry } = setup();
    registry.execute("tools.npmPackages");
    expect(store.getState().modal).toEqual({ kind: "npm" });
    registry.execute("tools.environmentVariables");
    expect(store.getState().modal).toEqual({ kind: "env" });
    // R22-2: ⌘I toggles the NPM Packages sheet closed when it's already open, run from a fresh setup().
    const fresh = setup();
    fresh.registry.execute("tools.npmPackages");
    fresh.registry.execute("tools.npmPackages");
    expect(fresh.store.getState().modal).toBeNull();
  });

  test("Set and Clear Working Directory reach Main for the active tab; Clear needs a WD", () => {
    const withoutWd = setup();
    withoutWd.registry.execute("wd.set");
    expect(withoutWd.api.pickWorkingDirectory).toHaveBeenCalledWith("t1");
    expect(withoutWd.registry.execute("wd.clear")).toBe("disabled");
    const withWd = setup("/work/api");
    expect(withWd.registry.execute("wd.clear")).toBe("executed");
    expect(withWd.api.clearWorkingDirectory).toHaveBeenCalledWith("t1");
    // R22-1: the palette description names the folder the WD commands act on.
    expect(withWd.registry.get("wd.clear")?.description?.()).toBe(strings.commands.folder("api"));
  });

  test("npm.install sends a trimmed spec and ignores anything else", () => {
    const { api, registry, store } = setup();
    // R23-1: an empty or whitespace spec does nothing, including no status message.
    registry.execute("npm.install", { spec: "" });
    registry.execute("npm.install", {});
    expect(store.getState().statusMessage).toBeNull();
    registry.execute("npm.install", { spec: " zod@4.6.4 " });
    expect(api.npmInstall.mock.calls).toEqual([["zod@4.6.4"]]);
    // R23-1: the status bar confirms the install started.
    expect(store.getState().statusMessage).toBe(strings.install.started("zod@4.6.4", null));
  });
});

// R-M2-T19A-1 (spec §7.2): "Copy All copies the entries visible under the current filter chip, not the whole
// output." The toolbar button obeyed the chip and this command did not -- it mapped over every visible entry and
// never read `outputFilter` -- so with the Errors chip selected the button copied the errors and the palette
// copied every row. `docs/parity.md` OU-11 had already flagged that nothing joined Copy All's two tested halves.
describe("output.copyAll follows the filter chip (R-M2-T19A-1)", () => {
  const resultEvent: RunEvent = {
    kind: "result",
    line: 1,
    source: "autolog",
    value: { t: "number", v: "2" },
    seq: 1,
    t: 0,
  };
  const logEvent: RunEvent = {
    kind: "console",
    level: "log",
    line: 2,
    groupDepth: 0,
    args: [{ t: "string", v: "hi" }],
    seq: 2,
    t: 0,
  };
  const errorEvent: RunEvent = {
    kind: "error",
    phase: "runtime",
    name: "TypeError",
    message: "boom",
    line: 3,
    column: 1,
    stack: [],
    seq: 3,
    t: 0,
  };
  const undefinedResult: RunEvent = {
    kind: "result",
    line: 4,
    source: "autolog",
    value: { t: "undefined" },
    seq: 4,
    t: 0,
  };
  const textOf = (...events: RunEvent[]) => events.map((event) => entryToText(event as DisplayEvent)).join("\n");

  let writes: string[] = [];
  let originalClipboard: Clipboard;
  beforeEach(() => {
    writes = [];
    originalClipboard = navigator.clipboard;
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: (text: string) => {
          writes.push(text);
          return Promise.resolve();
        },
      },
      configurable: true,
    });
  });
  afterEach(() => {
    Object.defineProperty(navigator, "clipboard", { value: originalClipboard, configurable: true });
  });

  function setup(events: RunEvent[] = [resultEvent, logEvent, errorEvent]) {
    const store = createAppStore();
    store.getState().hydrate({
      settings: defaultSettings(),
      session: defaultSession(() => createTab({ id: "t1" })),
      buffers: { t1: "" },
      safeMode: { active: false, reason: null },
      versions: { app: "0", bun: "1.4.0" },
    });
    store.getState().receiveState("r1", "transpiling", undefined, "t1");
    store.getState().receiveEvents("r1", events, "t1");
    const { api } = createFakeApi();
    const registry = new CommandRegistry();
    registry.register(
      ...createAppCommands({ store, api, tabs: createTabActions(store, api), run: () => {}, editor: () => null }),
    );
    return { store, registry };
  }

  test("the Errors chip copies only the error entries, never the whole output", async () => {
    const { store, registry } = setup();
    store.getState().setOutputFilter("errors");
    expect(registry.execute("output.copyAll")).toBe("executed");
    await Bun.sleep(1);
    expect(writes).toEqual([textOf(errorEvent)]);
  });

  test("the Results chip copies only the result entries", async () => {
    const { store, registry } = setup();
    store.getState().setOutputFilter("results");
    registry.execute("output.copyAll");
    await Bun.sleep(1);
    expect(writes).toEqual([textOf(resultEvent)]);
  });

  test("the All chip still copies every visible entry", async () => {
    const { store, registry } = setup();
    expect(store.getState().outputFilter).toBe("all");
    registry.execute("output.copyAll");
    await Bun.sleep(1);
    expect(writes).toEqual([textOf(resultEvent, logEvent, errorEvent)]);
  });

  test("an undefined result stays out of the copy while showUndefined is off", async () => {
    const { registry } = setup([resultEvent, undefinedResult]);
    registry.execute("output.copyAll");
    await Bun.sleep(1);
    expect(writes).toEqual([textOf(resultEvent)]);
  });

  // The zero-match case: the toolbar button is disabled here, so the command must not quietly replace whatever the
  // user had on their clipboard with an empty string.
  test("a chip that matches nothing disables the command instead of copying an empty string", async () => {
    const { store, registry } = setup([logEvent]);
    store.getState().setOutputFilter("errors");
    expect(registry.execute("output.copyAll")).toBe("disabled");
    await Bun.sleep(1);
    expect(writes).toEqual([]);
  });

  test("a denied clipboard write reports a status message instead of rejecting", async () => {
    const { store, registry } = setup();
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: () => Promise.reject(new Error("denied")) },
      configurable: true,
    });
    registry.execute("output.copyAll");
    await Bun.sleep(1);
    expect(store.getState().statusMessage).toBe(strings.commands.copyFailed);
  });
});
