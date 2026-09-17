import { describe, expect, test } from "bun:test";
import { createTab, defaultSession, defaultSettings, type Runtime, type TabState } from "@jslab/shared";
import { act, render, screen } from "@testing-library/react";
import type { MainApi } from "../src/api";
import { WebViewHosts } from "../src/output/WebViewHosts";
import type { WebviewElement } from "../src/output/webview-host";
import { type AppStore, createAppStore } from "../src/state/store";
import { createFakeApi } from "./fake-api";

/**
 * A real DOM node (so the tile can append it and React can remove it) carrying the `<electrobun-webview>` methods
 * the host registry drives. Electrobun registers the actual custom element inside a webview's own page, so in this
 * test DOM `document.createElement("electrobun-webview")` is an inert unknown element with no `on`/`off`/
 * `executeJavascript` of its own -- only the contract is testable here, which is what the `createWebview` seam is for.
 */
type FakeElement = HTMLElement & WebviewElement & { emit(event: string, detail?: unknown): void; executed: string[] };

function createFakeWebview(): FakeElement {
  // Through `unknown`: the devkit augments `HTMLElementTagNameMap`, so TypeScript already types this element as
  // Electrobun's own `WebviewTagElement` -- a far richer contract than the four methods this fake supplies.
  const element = document.createElement("electrobun-webview") as unknown as FakeElement;
  const listeners = new Map<string, Set<(event: CustomEvent) => void>>();
  element.executed = [];
  element.executeJavascript = (js: string) => void element.executed.push(js);
  element.reload = () => {};
  element.on = (event: string, listener: (event: CustomEvent) => void) => {
    const set = listeners.get(event) ?? new Set();
    listeners.set(event, set);
    set.add(listener);
  };
  element.off = (event: string, listener: (event: CustomEvent) => void) => void listeners.get(event)?.delete(listener);
  element.emit = (event: string, detail?: unknown) => {
    for (const listener of [...(listeners.get(event) ?? [])]) listener(new CustomEvent(event, { detail }));
  };
  return element;
}

function tabWith(id: string, overrides: { runtime?: Runtime; webviewVisible?: boolean } = {}): TabState {
  return createTab({
    id,
    runtime: overrides.runtime ?? "browser",
    layout: {
      orientation: "horizontal",
      editorSize: 55,
      outputVisible: true,
      tiles: {
        arrangement: "stacked",
        order: ["console", "webview"],
        webviewVisible: overrides.webviewVisible ?? false,
        consoleSize: 55,
      },
      // Required since Task 15 added per-tab mute; this fixture predates it and audio plays no part in
      // these wiring tests, so it takes the schema's own default.
      muted: false,
    },
  });
}

function hydrated(overrides: Parameters<typeof tabWith>[1] = {}) {
  const store = createAppStore();
  store.getState().hydrate({
    settings: defaultSettings(),
    session: defaultSession(() => tabWith("t1", overrides)),
    buffers: { t1: "" },
    safeMode: { active: false, reason: null },
    versions: { app: "0", bun: "1.4.0" },
  });
  return store;
}

/** The live element inside t1's tile, as an opaque value: `querySelector` types it as Electrobun's own tag. */
function tileWebview(): unknown {
  return screen.getByTestId("webview-tile-t1").querySelector("electrobun-webview");
}

function renderHosts(store: AppStore, api: MainApi) {
  const created: FakeElement[] = [];
  const view = render(
    <WebViewHosts
      store={store}
      dock={null}
      api={api}
      createWebview={() => {
        const element = createFakeWebview();
        created.push(element);
        return element;
      }}
    />,
  );
  return { created, view };
}

describe("WebViewHosts wired to the runtime in Main", () => {
  /**
   * The lifecycle collision, seen from the UI. Task 9 made the real webview element lazy -- it is created on the
   * tab's first Web View *enable* -- but a run doesn't require the user to have ever opened that pane. Main's
   * `webRunner.ensure` is what closes the gap, and this is the test that the gap is actually closed.
   */
  test("a run on a tab whose Web View was never switched on creates the element on demand", async () => {
    const store = hydrated();
    const { api, emit } = createFakeApi();
    const { created } = renderHosts(store, api);
    expect(created).toHaveLength(0);

    await emit("webRunner.ensure", { tabId: "t1", generation: 1 });

    expect(created).toHaveLength(1);
    expect(tileWebview()).toBe(created[0] ?? null);
  });

  test("the element it creates is registered: its dom-ready reaches Main as webRunner.ready", async () => {
    const store = hydrated();
    const { api, emit } = createFakeApi();
    const { created } = renderHosts(store, api);
    await emit("webRunner.ensure", { tabId: "t1", generation: 1 });

    act(() => created[0]?.emit("dom-ready"));

    // T9e: stamped with the generation `webRunner.ensure` named.
    expect(api.webRunnerReady).toHaveBeenCalledWith("t1", 1);
  });

  test("a page message from that element reaches Main tagged with its own tab", async () => {
    const store = hydrated();
    const { api, emit } = createFakeApi();
    const { created } = renderHosts(store, api);
    await emit("webRunner.ensure", { tabId: "t1", generation: 1 });

    act(() => created[0]?.emit("host-message", { seq: 1, message: { type: "ready" } }));

    expect(api.webRunnerMessage).toHaveBeenCalledWith("t1", { seq: 1, message: { type: "ready" } });
  });

  test("webRunner.execute runs the script inside that tab's element", async () => {
    const store = hydrated();
    const { api, emit } = createFakeApi();
    const { created } = renderHosts(store, api);
    await emit("webRunner.ensure", { tabId: "t1", generation: 1 });

    await emit("webRunner.execute", { tabId: "t1", js: "globalThis.ran = true;" });

    expect(created[0]?.executed).toEqual(["globalThis.ran = true;"]);
  });

  test("switching the Web View toggle on still creates the element with no involvement from Main (N4 preserved)", () => {
    const store = hydrated();
    const { api } = createFakeApi();
    const { created } = renderHosts(store, api);

    act(() => store.getState().toggleWebviewVisible());

    expect(created).toHaveLength(1);
  });

  /**
   * Kill (and a timed-out reset) destroy the webview and immediately ask for another, so "destroyed" must not be a
   * terminal state for the tile. The element is created once per generation, and `webRunner.destroy` is what ends
   * one -- otherwise the tab would be left with no webview and every later run would time out.
   */
  test("destroy then ensure gives the tab a genuinely new element", async () => {
    const store = hydrated();
    const { api, emit } = createFakeApi();
    const { created } = renderHosts(store, api);
    await emit("webRunner.ensure", { tabId: "t1", generation: 1 });

    await emit("webRunner.destroy", { tabId: "t1", generation: 1 });
    await emit("webRunner.ensure", { tabId: "t1", generation: 2 });

    expect(created).toHaveLength(2);
    expect(created[1]).not.toBe(created[0]);
    expect(tileWebview()).toBe(created[1] ?? null);
  });

  test("closing the tab tells Main the webview is gone", async () => {
    const store = hydrated();
    const { api, emit } = createFakeApi();
    renderHosts(store, api);
    await emit("webRunner.ensure", { tabId: "t1", generation: 1 });

    act(() => store.getState().removeTab("t1"));

    // T9e: stamped with the generation `webRunner.ensure` named.
    expect(api.webRunnerExit).toHaveBeenCalledWith("t1", 1);
  });
});
