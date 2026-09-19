import { describe, expect, test } from "bun:test";
import { createTab, defaultSession, defaultSettings, type Snippet } from "@jslab/shared";
import { createAppStore } from "../src/state/store";

const AT = "2026-09-16T10:00:00.000Z";
const record = (overrides: Partial<Snippet> = {}): Snippet => ({
  id: "s1",
  name: "fetchjson",
  description: "Fetch + parse JSON",
  body: "await fetch($0)",
  language: "typescript",
  createdAt: AT,
  updatedAt: AT,
  ...overrides,
});

const bootstrap = () => ({
  settings: defaultSettings(),
  session: defaultSession(() => createTab({ id: "t1" })),
  buffers: { t1: "" },
  safeMode: { active: false, reason: null } as const,
  versions: { app: "0", bun: "1.4.0" },
});

function hydrated() {
  const store = createAppStore();
  store.getState().hydrate(bootstrap());
  return store;
}

describe("snippet state (spec §13)", () => {
  test("starts empty and unloaded, so the panel can tell 'none yet' from 'not read yet'", () => {
    const state = hydrated().getState();
    expect([state.snippets, state.snippetsLoaded, state.snippetsRequest]).toEqual([[], false, null]);
  });

  test("receiveSnippets stores the library and marks it loaded", () => {
    const store = hydrated();
    store.getState().receiveSnippets([record()]);
    expect(store.getState().snippets).toEqual([record()]);
    expect(store.getState().snippetsLoaded).toBe(true);
    // An empty library still counts as loaded.
    store.getState().receiveSnippets([]);
    expect([store.getState().snippets, store.getState().snippetsLoaded]).toEqual([[], true]);
  });

  test("requestSnippets bumps a nonce every time, so a repeated request still reaches the panel", () => {
    const store = hydrated();
    store.getState().requestSnippets("focusSearch");
    expect(store.getState().snippetsRequest).toEqual({ kind: "focusSearch", body: "", nonce: 1 });
    store.getState().requestSnippets("focusSearch");
    expect(store.getState().snippetsRequest).toEqual({ kind: "focusSearch", body: "", nonce: 2 });
    store.getState().requestSnippets("newSnippet", "const a = 1");
    expect(store.getState().snippetsRequest).toEqual({ kind: "newSnippet", body: "const a = 1", nonce: 3 });
  });

  test("clearSnippetsRequest empties the channel without resetting the counter", () => {
    const store = hydrated();
    store.getState().requestSnippets("newSnippet", "x");
    store.getState().clearSnippetsRequest();
    expect(store.getState().snippetsRequest).toBeNull();
    store.getState().requestSnippets("focusSearch");
    expect(store.getState().snippetsRequest?.nonce).toBe(2);
  });

  test("the request channel is the only thing requesting and clearing touch: the library is left alone", () => {
    const store = hydrated();
    store.getState().receiveSnippets([record()]);
    // Opening the panel over a loaded library must not blank it, or the panel would flash empty on every ⌘B.
    store.getState().requestSnippets("focusSearch");
    expect([store.getState().snippets, store.getState().snippetsLoaded]).toEqual([[record()], true]);
    store.getState().clearSnippetsRequest();
    expect([store.getState().snippets, store.getState().snippetsLoaded]).toEqual([[record()], true]);
  });

  test("the library survives a tab switch (it is app state, not tab state)", () => {
    const store = hydrated();
    store.getState().receiveSnippets([record()]);
    store.getState().openTab(createTab({ id: "t2" }), "", true);
    expect(store.getState().snippets).toEqual([record()]);
  });

  test("the library survives re-hydration (it is app state, not session state)", () => {
    const store = hydrated();
    store.getState().receiveSnippets([record()]);
    // A second bootstrap (Main re-sends one after a settings reload) rebuilds tabs and buffers, never the library:
    // the library is read once over `snippets.list`, and blanking it here would leave the panel loaded-but-empty.
    store.getState().hydrate(bootstrap());
    expect([store.getState().snippets, store.getState().snippetsLoaded]).toEqual([[record()], true]);
  });
});
