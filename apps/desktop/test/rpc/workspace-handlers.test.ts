import { describe, expect, mock, test } from "bun:test";
import { createTab, defaultSession, defaultSettings } from "@jslab/shared";
import { InvalidPayloadError } from "../../src/main/rpc/validate";
import {
  createWorkspaceHandlers,
  mergeHandlers,
  type WorkspaceHandlerDeps,
} from "../../src/main/rpc/workspace-handlers";

function setup() {
  const calls: string[] = [];
  const deps = {
    session: {
      // The store's active tab after each mutation; the handlers read it to pre-warm only that tab's runner.
      session: defaultSession(() => createTab({ id: "b" })),
      createTab: mock(async (options: object) => createTab({ id: "new", ...options })),
      closeTab: mock(async (tabId: string) => {
        calls.push(`close:${tabId}`);
        return { closed: true, replacement: tabId === "last" ? createTab({ id: "fresh" }) : null, activeTabId: "b" };
      }),
      reopenClosed: mock(async () => ({ tab: createTab({ id: "old" }), content: "x" })),
      activateTab: mock(() => {}),
      reorderTabs: mock(() => {}),
      setViewState: mock(() => {}),
    },
    settings: { update: mock(async () => defaultSettings()) },
    coordinator: {
      disposeTab: mock((tabId: string) => {
        calls.push(`dispose:${tabId}`);
      }),
    },
    spares: { setActiveTab: mock((_tabId: string) => {}) },
    log: mock(() => {}),
  } satisfies WorkspaceHandlerDeps;
  return { deps, calls, handlers: createWorkspaceHandlers(deps) };
}

describe("workspace handlers", () => {
  test("tab.create validates and forwards only known fields", async () => {
    const { handlers, deps } = setup();
    expect((await handlers.requests["tab.create"]({ language: "jsx", content: "<a/>", evil: 1 })).tab.id).toBe("new");
    expect(deps.session.createTab).toHaveBeenCalledWith({ language: "jsx", content: "<a/>" });
    expect(() => handlers.requests["tab.create"]({ language: "cobol" })).toThrow(InvalidPayloadError);
  });

  test("tab.close disposes the tab's runs before closing and returns the replacement tab", async () => {
    const { handlers, calls, deps } = setup();
    expect(await handlers.requests["tab.close"]({ tabId: "a" })).toEqual({
      ok: true,
      activeTabId: "b",
      replacement: null,
    });
    const last = await handlers.requests["tab.close"]({ tabId: "last" });
    expect(last.replacement).toEqual({ tab: expect.objectContaining({ id: "fresh" }), content: "" });
    expect(calls).toEqual(["dispose:a", "close:a", "dispose:last", "close:last"]);
    expect(deps.spares.setActiveTab).toHaveBeenCalledWith("b");
  });

  test("tab.reopen and settings.update go through validation", async () => {
    const { handlers, deps } = setup();
    expect(await handlers.requests["tab.reopen"]({})).toEqual({
      tab: expect.objectContaining({ id: "old" }),
      content: "x",
    });
    expect(() => handlers.requests["tab.reopen"]("nope")).toThrow(InvalidPayloadError);
    await handlers.requests["settings.update"]({ patch: { editor: { lineWrap: false } } });
    expect(deps.settings.update).toHaveBeenCalledWith({ editor: { lineWrap: false } });
    expect(() => handlers.requests["settings.update"]({ patch: { editor: { lineWrap: [] } } })).toThrow(
      InvalidPayloadError,
    );
  });

  test("messages are validated; invalid ones are logged and dropped", () => {
    const { handlers, deps } = setup();
    handlers.messages["tab.activate"]({ tabId: "b" });
    handlers.messages["tab.reorder"]({ tabOrder: ["b", "a"] });
    handlers.messages["tab.viewState"]({ tabId: "a", viewState: { scrollTop: 10 } });
    handlers.messages["tab.reorder"]({ tabOrder: "b,a" });
    handlers.messages["tab.viewState"]({ tabId: "a", viewState: "x".repeat(200_001) });
    expect(deps.session.activateTab).toHaveBeenCalledWith("b");
    expect(deps.spares.setActiveTab).toHaveBeenCalledWith("b");
    expect(deps.session.reorderTabs).toHaveBeenCalledTimes(1);
    expect(deps.session.setViewState).toHaveBeenCalledTimes(1);
    expect(deps.log).toHaveBeenCalledTimes(2);
  });

  test("mergeHandlers combines groups and rejects duplicate method names", () => {
    const a = { requests: { x: () => 1 }, messages: { m: () => {} } };
    const b = { requests: { y: () => 2 }, messages: {} };
    expect(Object.keys(mergeHandlers(a, b).requests)).toEqual(["x", "y"]);
    expect(() => mergeHandlers(a, a)).toThrow(/Duplicate RPC handler: x/);
  });
});
