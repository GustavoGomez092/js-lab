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
});

describe("createSocketMethods", () => {
  const deps = (e2eEnabled: boolean) => ({
    e2eEnabled,
    bridge: { request: mock(async (method: string, params: unknown) => ({ method, params })) },
    mainState: () => ({ windowOpen: true }),
    screenshot: mock(async (name: string) => ({ path: `/shots/${name}.png` })),
    quit: mock(() => {}),
    uiAvailable: () => true,
    reopenWindow: mock(() => {}),
  });

  test("exposes no e2e methods unless JSLAB_E2E=1", () => {
    expect(Object.keys(createSocketMethods(deps(false)))).toEqual([]);
    expect(Object.keys(createSocketMethods(deps(true))).sort()).toEqual([
      "e2e.command",
      "e2e.key",
      "e2e.output",
      "e2e.quit",
      "e2e.reopen",
      "e2e.screenshot",
      "e2e.state",
      "e2e.type",
    ]);
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
    settingsOpen = true;
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
