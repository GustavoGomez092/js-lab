import { describe, expect, mock, test } from "bun:test";
import type { RunEvent } from "@jslab/rpc-schema";
import { createTab, defaultSession, defaultSettings, type Snippet } from "@jslab/shared";
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
  const executeCommand = mock((id: string): "executed" | "unknown" => (id === "run.start" ? "executed" : "unknown"));
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

  /**
   * `snippetCount` is consumed by M5b Task 11's scenarios and by nothing else in the UI, so without this test the
   * field is unpinned: hardcoding it to a constant passed the entire 518-test `apps/ui/test` suite (measured --
   * mutation P1 survived). TWO different sizes are asserted, so no constant can satisfy both.
   */
  test("state reports the snippet library size, and it tracks the library (spec §13)", async () => {
    const { agent, store } = setup();
    expect(await agent("state", {})).toMatchObject({ snippetCount: 0 });
    const at = "2026-09-16T10:00:00.000Z";
    const snippet = (name: string): Snippet => ({
      id: name,
      name,
      description: "",
      body: "x",
      language: null,
      createdAt: at,
      updatedAt: at,
    });
    store.getState().receiveSnippets([snippet("a"), snippet("b"), snippet("c")]);
    expect(await agent("state", {})).toMatchObject({ snippetCount: 3 });
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

  test("disabled commands are reported as disabled", async () => {
    const store = createAppStore();
    const agent = createE2EAgent({
      store,
      executeCommand: () => "disabled",
      editor: () => null,
      target: () => new EventTarget(),
      missingEditorActions: () => ["editor.action.nope"],
    });
    await expect(agent("command", { id: "tab.reopenClosed" })).rejects.toThrow("Command is disabled: tab.reopenClosed");
    expect(await agent("state", {})).toMatchObject({ missingEditorActions: ["editor.action.nope"] });
  });

  test("type writes into a focused plain input outside Monaco", async () => {
    const store = createAppStore();
    const input = document.createElement("input");
    document.body.appendChild(input);
    const seen: string[] = [];
    input.addEventListener("input", () => seen.push(input.value));
    const agent = createE2EAgent({ store, executeCommand: () => "unknown", editor: () => null, target: () => input });
    await agent("type", { text: "tog", replace: true });
    await agent("type", { text: "gle", replace: false });
    expect([input.value, seen]).toEqual(["toggle", ["tog", "toggle"]]);
    input.remove();
  });

  test("the e2e.openLink command clicks a temporary web link in the page (R-M1-17(e))", async () => {
    const { agent, executeCommand } = setup();
    const clicked: string[] = [];
    const onClick = (event: Event) => {
      clicked.push((event.target as HTMLAnchorElement).getAttribute("href") ?? "");
      event.preventDefault();
    };
    document.addEventListener("click", onClick);
    try {
      expect(await agent("command", { id: "e2e.openLink", args: { href: "https://example.com/x" } })).toEqual({
        executed: "e2e.openLink",
      });
    } finally {
      document.removeEventListener("click", onClick);
    }
    expect(clicked).toEqual(["https://example.com/x"]);
    expect(executeCommand).not.toHaveBeenCalled();
    expect(document.querySelector("a[data-e2e-link]")).toBeNull();
    await expect(agent("command", { id: "e2e.openLink", args: { href: "javascript:alert(1)" } })).rejects.toThrow(
      "e2e.openLink needs an http(s) URL",
    );
  });

  test("state carries TypeScript diagnostics, and e2e.completions asks the editor for completions", async () => {
    const store = createAppStore();
    store.getState().hydrate({
      settings: defaultSettings(),
      session: defaultSession(() => createTab({ id: "t1" })),
      buffers: { t1: "[1].m" },
      safeMode: { active: false, reason: null },
      versions: { app: "0.0.1", bun: "1.4.0" },
    });
    const agent = createE2EAgent({
      store,
      executeCommand: () => "unknown",
      editor: () => null,
      target: () => new EventTarget(),
      tsDiagnostics: async () => [
        { code: 2322, message: "Type 'string' is not assignable to type 'number'.", line: 1 },
      ],
      completions: async (offset) => (offset === 5 ? ["map"] : []),
    });
    expect(await agent("state", {})).toMatchObject({ tsDiagnostics: [{ code: 2322, line: 1 }] });
    expect(await agent("command", { id: "e2e.completions", args: { offset: 5 } })).toEqual({
      executed: "e2e.completions",
      completions: ["map"],
    });
  });

  test("e2e.installActions returns the editor's install-assist actions", async () => {
    const { store } = setup();
    const agent = createE2EAgent({
      store,
      executeCommand: () => "unknown",
      editor: () => null,
      target: () => new EventTarget(),
      installActions: async () => [{ title: "Install package zod", spec: "zod" }],
    });
    expect(await agent("command", { id: "e2e.installActions" })).toEqual({
      executed: "e2e.installActions",
      actions: [{ title: "Install package zod", spec: "zod" }],
    });
  });

  /**
   * XT-11 wiring. The geometry values are injected, so these assertions pin the SEAM (the handle's answer
   * reaches `e2e.state`, and `e2e.foldAll` reaches the editor) rather than Monaco's real fold behaviour --
   * that half is pinned by `packages/e2e/scenarios/format.test.ts` against a built app. Disclosed as such.
   */
  test("state carries the editor's fold and scroll geometry, and e2e.foldAll folds through the editor (XT-11)", async () => {
    const { store } = setup();
    const calls: string[] = [];
    const agent = createE2EAgent({
      store,
      executeCommand: () => "unknown",
      editor: () => null,
      target: () => new EventTarget(),
      viewGeometry: () => ({ scrollTop: 120, folding: '{"collapsedRegions":[1]}' }),
      foldAll: () => {
        calls.push("foldAll");
        return true;
      },
    });
    expect(await agent("state", {})).toMatchObject({
      viewGeometry: { scrollTop: 120, folding: '{"collapsedRegions":[1]}' },
    });
    expect(await agent("command", { id: "e2e.foldAll" })).toEqual({ executed: "e2e.foldAll", folded: true });
    expect(calls).toEqual(["foldAll"]);
  });

  test("an agent with no editor reports null geometry and a refused fold, rather than throwing (XT-11)", async () => {
    const { agent } = setup();
    expect(await agent("state", {})).toMatchObject({ viewGeometry: null });
    expect(await agent("command", { id: "e2e.foldAll" })).toEqual({ executed: "e2e.foldAll", folded: false });
  });

  test("tab snapshots carry the working directory and the suffixed label", async () => {
    const { store, agent } = setup();
    store.getState().applyTabUpdate({
      ...(store.getState().tabs.t1 as NonNullable<ReturnType<typeof store.getState>["tabs"]["t1"]>),
      workingDirectory: "/work/api",
    });
    expect(await agent("state", {})).toMatchObject({
      tabs: [{ id: "t1", workingDirectory: "/work/api", label: "scratch · api" }],
    });
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
