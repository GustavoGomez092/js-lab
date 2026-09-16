import { describe, expect, mock, test } from "bun:test";
import type { WebToHostMessage } from "@jslab/rpc-schema";
import { ASSERT_HOST_HOOK_SNIPPET, runtimePrelude } from "../../src/main/runtimes/web-adapter";
import { createUiWebviewSource, type WebviewBridge } from "../../src/main/runtimes/webview-source";

const BOOTSTRAP = "/* the runner-web bootstrap */";

function setup(bootstrap: () => Promise<string> = async () => BOOTSTRAP) {
  const calls: string[] = [];
  const bridge: WebviewBridge = {
    ensure: mock((tabId: string) => void calls.push(`ensure:${tabId}`)),
    execute: mock((tabId: string, js: string) => void calls.push(`execute:${tabId}:${js}`)),
    reload: mock((tabId: string) => void calls.push(`reload:${tabId}`)),
    destroy: mock((tabId: string) => void calls.push(`destroy:${tabId}`)),
  };
  const source = createUiWebviewSource({ bridge, readBootstrap: bootstrap });
  return { bridge, calls, source };
}

const tab = (tabId: string) => ({ tabId, workingDirectory: null });

describe("the production WebviewSource (Main ⇄ UI)", () => {
  test("ensure asks the UI to create the tab's webview and returns a host for it", async () => {
    const { bridge, source } = setup();

    const host = await source.ensure(tab("t1"));

    expect(bridge.ensure).toHaveBeenCalledWith("t1");
    expect(typeof host.send).toBe("function");
  });

  /**
   * The lifecycle collision this task exists to settle. After Task 9's lazy creation a webview exists only once
   * the tab's own Web View toggle has been switched on, so a run on an untouched `browser` tab reaches `ensure()`
   * with no element anywhere. The decision is to create one on demand rather than refuse the run: the webview is
   * the *runtime*, not a visual affordance, and code that only touches `document` (never showing anything) must
   * still run. `webRunner.ensure` is what carries that demand to the UI.
   */
  test("a run on a tab whose Web View was never switched on still gets a webview, created on demand", async () => {
    const { calls, source } = setup();

    await source.ensure(tab("never-toggled"));

    expect(calls).toContain("ensure:never-toggled");
  });

  test("a second ensure for the same tab reuses the one host and doesn't ask the UI again", async () => {
    const { bridge, source } = setup();

    const first = await source.ensure(tab("t1"));
    const second = await source.ensure(tab("t1"));

    expect(second).toBe(first);
    expect(bridge.ensure).toHaveBeenCalledTimes(1);
  });

  test("reset reloads the page and injects the bootstrap only once the UI reports dom-ready", async () => {
    const { bridge, calls, source } = setup();
    const host = await source.ensure(tab("t1"));

    const reset = host.reset("browser");
    expect(bridge.reload).toHaveBeenCalledWith("t1");
    // Nothing is injected yet: the page hasn't reported it is ready to receive script.
    expect(calls.some((call) => call.startsWith("execute:"))).toBe(false);

    source.ready("t1");
    await reset;

    const injected = calls.find((call) => call.startsWith("execute:t1:"));
    expect(injected).toContain(ASSERT_HOST_HOOK_SNIPPET);
    expect(injected).toContain(BOOTSTRAP);
  });

  /**
   * Task 9b (ledger ruling R-M4-T13-FETCHWIRE-1). The page has no other way to learn which web runtime it is: one
   * `WebviewSource` serves both adapters and the bootstrap bundle is byte-identical for every tab, so this prelude
   * is what decides whether `installFetchProxy` routes `fetch` through Main. It must be injected *before* the
   * bootstrap, because `startRunnerWeb` reads it synchronously as it installs the proxy.
   */
  test("reset tells the page which web runtime it is, before the bootstrap runs", async () => {
    for (const runtime of ["browser", "browser-node"] as const) {
      const { calls, source } = setup();
      const host = await source.ensure(tab("t1"));
      const reset = host.reset(runtime);
      source.ready("t1");
      await reset;

      const injected = calls.find((call) => call.startsWith("execute:t1:")) ?? "";
      expect(injected).toContain(runtimePrelude(runtime));
      // Order is load-bearing, not incidental: the bootstrap reads the global as it installs the fetch proxy.
      expect(injected.indexOf(runtimePrelude(runtime))).toBeLessThan(injected.indexOf(BOOTSTRAP));
    }
  });

  test("a host message relayed from the UI reaches the host's own listeners", async () => {
    const { source } = setup();
    const host = await source.ensure(tab("t1"));
    const seen: WebToHostMessage[] = [];
    host.onMessage((message) => seen.push(message));

    source.receive("t1", { seq: 1, message: { type: "heartbeat" } });

    expect(seen).toEqual([{ type: "heartbeat" }]);
  });

  test("a message for a tab with no host is ignored rather than throwing", () => {
    const { source } = setup();
    expect(() => source.receive("gone", { seq: 1, message: { type: "heartbeat" } })).not.toThrow();
    expect(() => source.ready("gone")).not.toThrow();
    expect(() => source.exit("gone")).not.toThrow();
  });

  test("an exit reported by the UI fires onExit and discards the host, so the next ensure builds a fresh one", async () => {
    const { bridge, source } = setup();
    const host = await source.ensure(tab("t1"));
    const exits = mock(() => {});
    host.onExit(exits);

    source.exit("t1");
    expect(exits).toHaveBeenCalledTimes(1);

    const replacement = await source.ensure(tab("t1"));
    expect(replacement).not.toBe(host);
    expect(bridge.ensure).toHaveBeenCalledTimes(2);
  });

  test("destroy tears the UI element down and never reports it as an exit", async () => {
    const { bridge, source } = setup();
    const host = await source.ensure(tab("t1"));
    const exits = mock(() => {});
    host.onExit(exits);

    source.destroy("t1");

    expect(bridge.destroy).toHaveBeenCalledWith("t1");
    // `WebviewHost.onExit` promises it never fires for the host's own teardown -- Kill would otherwise look like
    // a crash and add a spurious "Web runner exited unexpectedly." error to the tab's output.
    expect(exits).not.toHaveBeenCalled();
  });

  test("destroy then ensure asks the UI for a new element", async () => {
    const { bridge, source } = setup();
    await source.ensure(tab("t1"));
    source.destroy("t1");

    await source.ensure(tab("t1"));

    expect(bridge.ensure).toHaveBeenCalledTimes(2);
  });

  test("the bootstrap is read once and shared by every tab", async () => {
    const readBootstrap = mock(async () => BOOTSTRAP);
    const { source } = setup(readBootstrap);

    await source.ensure(tab("t1"));
    await source.ensure(tab("t2"));

    expect(readBootstrap).toHaveBeenCalledTimes(1);
  });

  test("two tabs get independent hosts, and one tab's traffic never reaches the other", async () => {
    const { source } = setup();
    const first = await source.ensure(tab("t1"));
    const second = await source.ensure(tab("t2"));
    const seen: WebToHostMessage[] = [];
    second.onMessage((message) => seen.push(message));

    source.receive("t1", { seq: 1, message: { type: "heartbeat" } });

    expect(first).not.toBe(second);
    expect(seen).toEqual([]);
  });
});
