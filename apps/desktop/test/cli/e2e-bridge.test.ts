import { describe, expect, mock, test } from "bun:test";
import type { E2ERequest } from "@jslab/rpc-schema";
import { E2EBridge } from "../../src/main/cli/e2e-bridge";
import { createSocketMethods } from "../../src/main/cli/socket-methods";

describe("E2EBridge", () => {
  test("resolves and rejects by request id", async () => {
    const sent: E2ERequest[] = [];
    const bridge = new E2EBridge((request) => sent.push(request));
    const first = bridge.request("state", {});
    const second = bridge.request("command", { id: "run.start" });
    bridge.receive({ reqId: 999, ok: true, result: "ignored" });
    bridge.receive({ reqId: sent[1]?.reqId ?? 0, ok: false, error: "Unknown command" });
    bridge.receive({ reqId: sent[0]?.reqId ?? 0, ok: true, result: { ready: true } });
    expect(await first).toEqual({ ready: true });
    await expect(second).rejects.toThrow("Unknown command");
  });

  test("times out when the UI never answers", async () => {
    const bridge = new E2EBridge(() => {}, 20);
    await expect(bridge.request("state", {})).rejects.toThrow(/did not answer state within 20 ms/);
  });

  test("rejectAll fails every pending request", async () => {
    const bridge = new E2EBridge(() => {});
    const pending = bridge.request("output", {});
    bridge.rejectAll("window closed");
    await expect(pending).rejects.toThrow("window closed");
  });

  /**
   * The delivery gate. A webview whose bundle has not executed drops whatever is sent to it, so a request raised
   * during a boot used to go nowhere and fail only at the bridge's own timeout -- measured at 6 cold launches out
   * of 6, ~15.00s each. These cover the three things the gate has to get right.
   */
  test("a request raised while the view is booting is held, then sent once the view reports in", async () => {
    const sent: E2ERequest[] = [];
    const bridge = new E2EBridge((request) => sent.push(request), 5_000);
    bridge.viewBooting();
    const pending = bridge.request("state", {});
    await Bun.sleep(20);
    // Nothing went out: sending now is what silently loses the request.
    expect(sent).toEqual([]);

    bridge.viewReady();
    await Bun.sleep(0);
    expect(sent).toHaveLength(1);
    bridge.receive({ reqId: sent[0]?.reqId ?? 0, ok: true, result: { ready: true } });
    expect(await pending).toEqual({ ready: true });
  });

  test("the gate is open by default and still times out for a view that never boots", async () => {
    const sent: E2ERequest[] = [];
    const open = new E2EBridge((request) => sent.push(request));
    const pending = open.request("state", {});
    // Synchronously, in the same tick: an ungated bridge must behave exactly as it did before the gate existed.
    expect(sent).toHaveLength(1);
    // Settled rather than abandoned. A `void`ed request here keeps its 15 s timer alive and rejects long after
    // this file is done, and Bun charges that unhandled rejection to whichever test happens to be running then --
    // which is exactly how this test first broke an unrelated RunCoordinator case two files later.
    open.receive({ reqId: sent[0]?.reqId ?? 0, ok: true, result: null });
    expect(await pending).toBeNull();

    const stuck = new E2EBridge(() => {}, 20);
    stuck.viewBooting();
    await expect(stuck.request("state", {})).rejects.toThrow(/did not answer state within 20 ms/);
  });

  test("a request retired while the gate was shut is never sent late", async () => {
    const sent: E2ERequest[] = [];
    const bridge = new E2EBridge((request) => sent.push(request));
    bridge.viewBooting();
    const pending = bridge.request("output", {});
    bridge.rejectAll("window closed");
    await expect(pending).rejects.toThrow("window closed");

    // The window that closed is not the window that boots next; delivering to it would answer a dead request.
    bridge.viewReady();
    await Bun.sleep(0);
    expect(sent).toEqual([]);
  });
});

describe("createSocketMethods", () => {
  const deps = (e2eEnabled: boolean) => ({
    e2eEnabled,
    open: mock(async (params: unknown) => ({ tabIds: ["t1"], params })),
    bridge: { request: mock(async (method: string, params: unknown) => ({ method, params })) },
    mainState: () => ({ windowOpen: true }),
    screenshot: mock(async (name: string, _window?: string) => ({ path: `/shots/${name}.png` })),
    quit: mock(() => {}),
    uiAvailable: () => true,
    reopenWindow: mock(() => {}),
  });

  test("open is always available; e2e methods need JSLAB_E2E=1", () => {
    expect(Object.keys(createSocketMethods(deps(false)))).toEqual(["open"]);
    expect(Object.keys(createSocketMethods(deps(true))).sort()).toEqual([
      "e2e.command",
      "e2e.key",
      "e2e.output",
      "e2e.quit",
      "e2e.reopen",
      "e2e.screenshot",
      "e2e.state",
      "e2e.type",
      "open",
    ]);
  });

  test("open validates its params and returns only tabIds, so it can't spoof the envelope", async () => {
    const d = deps(false);
    const methods = createSocketMethods(d);
    expect(await methods.open?.({ code: "1 + 1", run: true })).toEqual({
      tabIds: ["t1"],
      params: { code: "1 + 1", run: true },
    });
    await expect(methods.open?.({ files: ["relative.ts"] }) ?? Promise.resolve()).rejects.toThrow();
    await expect(methods.open?.({}) ?? Promise.resolve()).rejects.toThrow();
  });

  test("validates params, forwards to the UI and merges Main state", async () => {
    const d = deps(true);
    const methods = createSocketMethods(d);
    expect(await methods["e2e.type"]?.({ text: "1 + 1", extra: 1 })).toEqual({
      result: { method: "type", params: { text: "1 + 1" } },
    });
    expect(await methods["e2e.state"]?.({})).toEqual({
      ui: { method: "state", params: {} },
      main: { windowOpen: true },
    });
    await expect(methods["e2e.key"]?.({ key: "" }) ?? Promise.resolve()).rejects.toThrow();
  });

  test("screenshot names are restricted to a safe file name", async () => {
    const d = deps(true);
    const methods = createSocketMethods(d);
    expect(await methods["e2e.screenshot"]?.({ name: "typing-result" })).toEqual({ path: "/shots/typing-result.png" });
    await expect(methods["e2e.screenshot"]?.({ name: "../escape" }) ?? Promise.resolve()).rejects.toThrow();
    expect(d.screenshot).toHaveBeenCalledTimes(1);
  });

  test("with the window closed, state reports ui null, UI methods fail fast and reopen restores it", async () => {
    let open = false;
    const d = { ...deps(true), uiAvailable: () => open, mainState: () => ({ windowOpen: open }) };
    const methods = createSocketMethods(d);
    expect(await methods["e2e.state"]?.({})).toEqual({ ui: null, main: { windowOpen: false } });
    await expect(methods["e2e.type"]?.({ text: "x" }) ?? Promise.resolve()).rejects.toThrow(
      "The JSLab window is closed",
    );
    expect(d.bridge.request).not.toHaveBeenCalled();
    await methods["e2e.reopen"]?.({});
    open = true;
    expect(d.reopenWindow).toHaveBeenCalledTimes(1);
    expect(await methods["e2e.state"]?.({})).toEqual({
      ui: { method: "state", params: {} },
      main: { windowOpen: true },
    });
    // m-7: the window closes while the state request is in flight, so the bridge rejects.
    d.bridge.request.mockImplementationOnce(async () => {
      open = false;
      throw new Error("The JSLab window closed");
    });
    expect(await methods["e2e.state"]?.({})).toEqual({ ui: null, main: { windowOpen: false } });
  });

  test("window: settings routes UI calls to the Settings window bridge", async () => {
    let settingsOpen = false;
    const settingsBridge = {
      request: mock(async (method: string, params: unknown) => ({ settingsWindow: method, params })),
    };
    const d = {
      ...deps(true),
      settingsBridge,
      uiAvailable: (window?: string) => window !== "settings" || settingsOpen,
    };
    const methods = createSocketMethods(d);
    expect(await methods["e2e.state"]?.({ window: "settings" })).toEqual({ ui: null, main: { windowOpen: true } });
    await expect(
      methods["e2e.command"]?.({ id: "settings.set", window: "settings" }) ?? Promise.resolve(),
    ).rejects.toThrow("The Settings window is closed");
    // Screenshots capture the requested window: main by default, Settings only while it is open (review m-2).
    expect(await methods["e2e.screenshot"]?.({ name: "typing-result" })).toEqual({ path: "/shots/typing-result.png" });
    expect(d.screenshot.mock.calls).toEqual([["typing-result", "main"]]);
    await expect(
      methods["e2e.screenshot"]?.({ name: "settings-general", window: "settings" }) ?? Promise.resolve(),
    ).rejects.toThrow("The Settings window is closed");
    expect(d.screenshot).toHaveBeenCalledTimes(1);
    settingsOpen = true;
    expect(await methods["e2e.screenshot"]?.({ name: "settings-general", window: "settings" })).toEqual({
      path: "/shots/settings-general.png",
    });
    expect(d.screenshot.mock.calls).toEqual([
      ["typing-result", "main"],
      ["settings-general", "settings"],
    ]);
    expect(
      await methods["e2e.command"]?.({
        id: "settings.set",
        args: { key: "view.statusBar", value: false },
        window: "settings",
      }),
    ).toEqual({
      result: {
        settingsWindow: "command",
        params: { id: "settings.set", args: { key: "view.statusBar", value: false } },
      },
    });
    expect(d.bridge.request).not.toHaveBeenCalled();
  });
});
