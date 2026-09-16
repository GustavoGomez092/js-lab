import { describe, expect, test } from "bun:test";
import { createWebviewHostRegistry, type WebviewElement } from "../src/output/webview-host";
import { createFakeApi } from "./fake-api";

/**
 * A stand-in for one `<electrobun-webview>` element: the same four methods and two events the registry actually
 * touches (`apps/desktop/.hutch/devkit/api/browser/webviewtag.ts` -- `executeJavascript`, `reload`, `remove`,
 * `on`/`off`, and the `dom-ready` / `host-message` `CustomEvent`s). Using a fake here rather than a real custom
 * element is not a shortcut: `electrobun-webview` is registered by Electrobun's own preload inside a real webview,
 * so it does not exist in this test DOM at all -- only its contract does.
 */
class FakeWebviewElement implements WebviewElement {
  readonly executed: string[] = [];
  reloadCount = 0;
  removed = false;
  readonly #listeners = new Map<string, Set<(event: CustomEvent) => void>>();

  executeJavascript(js: string): void {
    this.executed.push(js);
  }

  reload(): void {
    this.reloadCount++;
  }

  remove(): void {
    this.removed = true;
  }

  on(event: string, listener: (event: CustomEvent) => void): void {
    const set = this.#listeners.get(event) ?? new Set();
    this.#listeners.set(event, set);
    set.add(listener);
  }

  off(event: string, listener: (event: CustomEvent) => void): void {
    this.#listeners.get(event)?.delete(listener);
  }

  /** Fires one webview event the way Electrobun's tag does: a `CustomEvent` carrying `detail`. */
  emit(event: string, detail?: unknown): void {
    for (const listener of [...(this.#listeners.get(event) ?? [])]) {
      listener(new CustomEvent(event, { detail }));
    }
  }

  get listenerCount(): number {
    let total = 0;
    for (const set of this.#listeners.values()) total += set.size;
    return total;
  }
}

function harness() {
  const { api, emit } = createFakeApi();
  const registry = createWebviewHostRegistry(api);
  const needed: string[] = [];
  registry.onNeedsElement((tabId) => needed.push(tabId));
  return { api, emit, registry, needed };
}

describe("the UI-side webview host registry", () => {
  test("relays a registered element's host-message to Main, tagged with its own tab", () => {
    const { api, registry } = harness();
    const t1 = new FakeWebviewElement();
    const t2 = new FakeWebviewElement();
    registry.register("t1", t1);
    registry.register("t2", t2);

    t1.emit("host-message", { seq: 1, message: { type: "ready" } });

    expect(api.webRunnerMessage).toHaveBeenCalledTimes(1);
    expect(api.webRunnerMessage).toHaveBeenCalledWith("t1", { seq: 1, message: { type: "ready" } });
  });

  test("relays dom-ready as webRunner.ready -- the point Main is allowed to inject script", () => {
    const { api, registry } = harness();
    const element = new FakeWebviewElement();
    registry.register("t1", element);

    element.emit("dom-ready");

    expect(api.webRunnerReady).toHaveBeenCalledWith("t1");
  });

  test("webRunner.execute runs the script in that tab's element and no other", async () => {
    const { emit, registry } = harness();
    const t1 = new FakeWebviewElement();
    const t2 = new FakeWebviewElement();
    registry.register("t1", t1);
    registry.register("t2", t2);

    await emit("webRunner.execute", { tabId: "t1", js: "globalThis.x = 1;" });

    expect(t1.executed).toEqual(["globalThis.x = 1;"]);
    expect(t2.executed).toEqual([]);
  });

  test("webRunner.reload reloads an element that already exists", async () => {
    const { emit, registry } = harness();
    const element = new FakeWebviewElement();
    registry.register("t1", element);

    await emit("webRunner.reload", { tabId: "t1" });

    expect(element.reloadCount).toBe(1);
  });

  /**
   * The double-load guard. Main sends `reload` the moment `ensure()` resolves, but the UI creates the element
   * asynchronously (a React state change, then an effect), so the reload routinely arrives first. Replaying it
   * after creation would load the page twice: the second load wipes the bootstrap the host injected after the
   * first `dom-ready`, and the run then hangs with no `ready` that belongs to it. A brand-new element's own first
   * load already *is* the fresh realm the reload was asking for, so it satisfies the request instead.
   */
  test("a reload arriving before the element exists is satisfied by that element's first load, not a second one", async () => {
    const { api, emit, registry } = harness();
    await emit("webRunner.reload", { tabId: "t1" });

    const element = new FakeWebviewElement();
    registry.register("t1", element);
    expect(element.reloadCount).toBe(0);

    element.emit("dom-ready");
    expect(api.webRunnerReady).toHaveBeenCalledWith("t1");
  });

  test("webRunner.execute for a tab with no element is dropped rather than replayed into a later realm", async () => {
    const { emit, registry } = harness();
    await emit("webRunner.execute", { tabId: "t1", js: "boom()" });

    const element = new FakeWebviewElement();
    registry.register("t1", element);

    expect(element.executed).toEqual([]);
  });

  test("webRunner.destroy removes the element, stops relaying, and is not reported back as an exit", async () => {
    const { api, emit, registry } = harness();
    const element = new FakeWebviewElement();
    registry.register("t1", element);

    await emit("webRunner.destroy", { tabId: "t1" });

    expect(element.removed).toBe(true);
    expect(element.listenerCount).toBe(0);
    element.emit("host-message", { seq: 1, message: { type: "heartbeat" } });
    expect(api.webRunnerMessage).not.toHaveBeenCalled();
    // `WebviewHost.onExit` promises it never fires for the host's own destroy; reporting one here would make Kill
    // look like a crash and put a spurious "Web runner exited unexpectedly." error in the tab's output.
    expect(api.webRunnerExit).not.toHaveBeenCalled();
  });

  test("webRunner.ensure asks for an element only when the tab hasn't got one", async () => {
    const { emit, registry, needed } = harness();
    await emit("webRunner.ensure", { tabId: "t1" });
    expect(needed).toEqual(["t1"]);

    registry.register("t1", new FakeWebviewElement());
    await emit("webRunner.ensure", { tabId: "t1" });
    expect(needed).toEqual(["t1"]);
  });

  test("a destroyed tab asks for a fresh element on the next ensure -- what Kill's destroy/recreate needs", async () => {
    const { emit, registry, needed } = harness();
    registry.register("t1", new FakeWebviewElement());
    await emit("webRunner.destroy", { tabId: "t1" });

    await emit("webRunner.ensure", { tabId: "t1" });

    expect(needed).toEqual(["t1"]);
  });

  test("unregistering a tab's element stops relaying and reports the webview as gone", () => {
    const { api, registry } = harness();
    const element = new FakeWebviewElement();
    registry.register("t1", element);
    registry.unregister("t1");

    element.emit("host-message", { seq: 1, message: { type: "heartbeat" } });

    expect(element.listenerCount).toBe(0);
    expect(api.webRunnerMessage).not.toHaveBeenCalled();
    // The tab closed or stopped being web-capable: Main must hear about it, or `WebAdapter` keeps driving a
    // webview that no longer exists and the run only ends when a timeout notices.
    expect(api.webRunnerExit).toHaveBeenCalledWith("t1");
  });

  test("unregistering a tab that never had an element reports nothing", () => {
    const { api, registry } = harness();
    registry.unregister("t1");
    expect(api.webRunnerExit).not.toHaveBeenCalled();
  });

  test("dispose drops every subscription, so a late message reaches nothing", async () => {
    const { api, emit, registry } = harness();
    const element = new FakeWebviewElement();
    registry.register("t1", element);

    registry.dispose();
    await emit("webRunner.execute", { tabId: "t1", js: "boom()" });
    element.emit("dom-ready");

    expect(element.executed).toEqual([]);
    expect(api.webRunnerReady).not.toHaveBeenCalled();
  });
});
