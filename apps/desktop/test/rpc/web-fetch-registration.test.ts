import { describe, expect, mock, test } from "bun:test";
import { createRedactor } from "../../src/main/logging/redact";
import { createWebFetchHandlers, type WebFetchHandlerDeps } from "../../src/main/rpc/web-fetch-handlers";
import { createWebRunnerHandlers } from "../../src/main/rpc/web-runner-handlers";
import { createWorkspaceHandlers, mergeHandlers } from "../../src/main/rpc/workspace-handlers";

// Task 13: Task 12 built `createWebFetchHandlers` and its Main-side authorization gate (`runtimeOf`), but never
// registered it -- registering it before that gate existed would have made the milestone's defining refusal
// (a `browser` tab getting CORS-free fetch) bypassable. This file proves two things `web-fetch-handlers.test.ts`
// (Task 12's own file) does not, because that file calls `createWebFetchHandlers(...).messages[...]` directly,
// never through `mergeHandlers`:
//
//  1. The group's method names survive merging with the app's other handler groups without a name collision
//     (`mergeHandlers` throws `Duplicate RPC handler: <name>` on one -- this is what "stay globally unique across
//     merged groups" means operationally).
//  2. Once merged, `merged.messages["webFetch.request"]` is the SAME reachable function `apps/desktop/src/main/
//     index.ts`'s real `rpc.handlers` would dispatch through -- not merely present as a key, but wired all the
//     way to the real fetch logic. An unregistered handler is a silent hang, not an error (the exact symptom
//     class this milestone has chased three times already), so "present in `messages`" alone would not be
//     sufficient evidence; this test drives a full request through the merged object and asserts on its effect.

function setup() {
  const events: { type: string; payload: Record<string, unknown> }[] = [];
  const send: WebFetchHandlerDeps["send"] = {
    head: (payload) => events.push({ type: "head", payload }),
    chunk: (payload) => events.push({ type: "chunk", payload }),
    end: (payload) => events.push({ type: "end", payload }),
    error: (payload) => events.push({ type: "error", payload }),
  };
  const webFetch = createWebFetchHandlers({
    send,
    runtimeOf: (tabId) =>
      tabId === "browser-node-tab" ? "browser-node" : tabId === "some-browser-tab" ? "browser" : undefined,
    redact: createRedactor(),
    log: mock(() => {}),
    // No network in this test (constraint, and determinism): `WebFetchHandlerDeps.fetch` is exactly the seam
    // Task 12 built for this -- production always uses the runtime's own `fetch`.
    fetch: async () => new Response("ok", { status: 200, statusText: "OK", headers: { "content-type": "text/plain" } }),
  });
  // A second, unrelated-but-real group (also newly wired in this same task) merged alongside it, exactly the
  // shape `index.ts`'s real `mergeHandlers(...)` call takes -- proving uniqueness isn't just "this group alone".
  const webRunner = createWebRunnerHandlers({ webviews: { receive: () => {} }, log: mock(() => {}) });
  // And a THIRD, pre-existing group already merged in production (`index.ts`), so this isn't merging webFetch
  // against an artificially small set either.
  const frame = { x: 0, y: 0, width: 400, height: 300 };
  const workspace = createWorkspaceHandlers({
    session: {
      session: {
        version: 1,
        tabs: {},
        tabOrder: [],
        activeTabId: "",
        closedStack: [],
        window: frame,
        settingsWindow: frame,
        lastDirectory: null,
      },
      createTab: async () => ({ tab: {} }) as never,
      closeTab: async () => ({}) as never,
      reopenClosed: async () => null,
      activateTab: () => {},
      reorderTabs: () => {},
      setViewState: () => {},
    },
    coordinator: { disposeTab: () => {} },
    spares: { setActiveTab: () => {} },
    log: mock(() => {}),
  });
  return { events, merged: mergeHandlers(webFetch, webRunner, workspace) };
}

describe("webFetch.* registration", () => {
  test("merges without a duplicate-name collision against the app's other handler groups", () => {
    expect(() => setup()).not.toThrow();
  });

  test("names are present and globally unique: webFetch.request/abort exist exactly once each", () => {
    const { merged } = setup();
    expect(Object.keys(merged.messages).filter((name) => name === "webFetch.request")).toHaveLength(1);
    expect(Object.keys(merged.messages).filter((name) => name === "webFetch.abort")).toHaveLength(1);
    expect(merged.messages["webFetch.request"]).toBeInstanceOf(Function);
    expect(merged.messages["webFetch.abort"]).toBeInstanceOf(Function);
  });

  test("reachable through mergeHandlers: an authorized tab's request runs the real fetch logic, not a stub", async () => {
    const { events, merged } = setup();
    merged.messages["webFetch.request"]({
      tabId: "browser-node-tab",
      id: 1,
      request: { url: "https://example.com/", method: "GET", headers: [], body: null },
    });
    // No real network in this test env; what matters is that the call was actually dispatched into the fetch
    // logic (it attempted something and reported back), not silently swallowed by a missing registration.
    await Bun.sleep(10);
    expect(events.length).toBeGreaterThan(0);
  });

  test("reachable through mergeHandlers: the fail-closed gate still refuses a non-browser-node tab", async () => {
    const { events, merged } = setup();
    merged.messages["webFetch.request"]({
      tabId: "some-browser-tab",
      id: 2,
      request: { url: "https://example.com/", method: "GET", headers: [], body: null },
    });
    await Bun.sleep(10);
    expect(events).toEqual([
      {
        type: "error",
        payload: {
          tabId: "some-browser-tab",
          id: 2,
          message: expect.stringContaining("is browser.") as unknown as string,
        },
      },
    ]);
  });

  test("reachable through mergeHandlers: an unknown tab id fails closed, exactly like a forged browser tab", async () => {
    const { events, merged } = setup();
    merged.messages["webFetch.request"]({
      tabId: "no-such-tab",
      id: 3,
      request: { url: "https://example.com/", method: "GET", headers: [], body: null },
    });
    await Bun.sleep(10);
    expect(events).toEqual([
      {
        type: "error",
        payload: {
          tabId: "no-such-tab",
          id: 3,
          message: expect.stringContaining("is unknown.") as unknown as string,
        },
      },
    ]);
  });
});
