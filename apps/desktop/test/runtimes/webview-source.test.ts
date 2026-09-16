import { describe, expect, mock, test } from "bun:test";
import type { WebToHostMessage } from "@jslab/rpc-schema";
import { ASSERT_HOST_HOOK_SNIPPET, runtimePrelude } from "../../src/main/runtimes/web-adapter";
import { createUiWebviewSource, type WebviewBridge } from "../../src/main/runtimes/webview-source";

const BOOTSTRAP = "/* the runner-web bootstrap */";

function setup(bootstrap: () => Promise<string> = async () => BOOTSTRAP) {
  const calls: string[] = [];
  const bridge: WebviewBridge = {
    ensure: mock((tabId: string, generation: number) => void calls.push(`ensure:${tabId}:${generation}`)),
    execute: mock((tabId: string, js: string) => void calls.push(`execute:${tabId}:${js}`)),
    reload: mock((tabId: string) => void calls.push(`reload:${tabId}`)),
    destroy: mock((tabId: string, generation: number) => void calls.push(`destroy:${tabId}:${generation}`)),
  };
  const source = createUiWebviewSource({ bridge, readBootstrap: bootstrap });
  return { bridge, calls, source };
}

const tab = (tabId: string) => ({ tabId, workingDirectory: null });

describe("the production WebviewSource (Main ⇄ UI)", () => {
  test("ensure asks the UI to create the tab's webview and returns a host for it", async () => {
    const { bridge, source } = setup();

    const host = await source.ensure(tab("t1"));

    // T9e: the first entry for a tab is generation 1.
    expect(bridge.ensure).toHaveBeenCalledWith("t1", 1);
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

    expect(calls).toContain("ensure:never-toggled:1");
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

    source.ready("t1", 1);
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
      source.ready("t1", 1);
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
    expect(() => source.ready("gone", 1)).not.toThrow();
    expect(() => source.exit("gone", 1)).not.toThrow();
  });

  test("an exit reported by the UI fires onExit and discards the host, so the next ensure builds a fresh one", async () => {
    const { bridge, source } = setup();
    const host = await source.ensure(tab("t1"));
    const exits = mock(() => {});
    host.onExit(exits);

    source.exit("t1", 1);
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

    expect(bridge.destroy).toHaveBeenCalledWith("t1", 1);
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

  // T9e (CodeRabbit on PR #3, ledger task 9e): `webRunner.ready` / `.exit` used to carry only a tabId, so a late
  // event from an entry this source had already replaced could reach the replacement -- a `ready` waking the
  // wrong host, or an `exit` deleting it and firing a spurious crash on a webview that is still alive. Task 9c
  // closed the readiness-*wait* half of this inside the adapter (deferring `onMessage` until `host.reset()`
  // resolves); these two tests are the other half, reproduced directly against this module's own registry.
  describe("a generation gate keeps a stale ready/exit from reaching the entry that replaced it (T9e)", () => {
    test("stale exit: destroy, recreate, then the OLD generation's exit leaves the replacement untouched", async () => {
      const { source } = setup();
      const first = await source.ensure(tab("t1"));

      source.destroy("t1");
      const replacement = await source.ensure(tab("t1"));
      const replacementExits = mock(() => {});
      replacement.onExit(replacementExits);

      // The old element's exit, generation 1, arrives after generation 2 already replaced it.
      source.exit("t1", 1);

      expect(replacementExits).not.toHaveBeenCalled();
      // Node identity, not mere presence (this milestone has twice had a presence check quietly stand in for an
      // identity assertion, and both times the suite stayed green while the invariant was gone): the exact same
      // host object handed back by the second `ensure()` must still be the one live for this tab afterward.
      const stillLive = await source.ensure(tab("t1"));
      expect(stillLive).toBe(replacement);
      expect(stillLive).not.toBe(first);
    });

    test("stale ready: destroy, recreate, then the OLD generation's ready never satisfies the replacement's own wait", async () => {
      const { calls, source } = setup();
      await source.ensure(tab("t1"));

      source.destroy("t1");
      const replacement = await source.ensure(tab("t1"));
      const reset = replacement.reset("browser");

      // The old element's dom-ready, generation 1, arrives after generation 2 already replaced it.
      source.ready("t1", 1);
      // Nothing injected yet: the stale ready did not satisfy generation 2's own wait -- if it had, this would
      // already contain an `execute:t1:` call for the bootstrap.
      expect(calls.some((call) => call.startsWith("execute:t1:"))).toBe(false);

      // Generation 2's own ready is what actually satisfies it.
      source.ready("t1", 2);
      await reset;
      expect(calls.some((call) => call.startsWith("execute:t1:"))).toBe(true);

      // Node identity: the object `ensure()` hands back for this tab is still the same replacement throughout.
      const stillLive = await source.ensure(tab("t1"));
      expect(stillLive).toBe(replacement);
    });
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
