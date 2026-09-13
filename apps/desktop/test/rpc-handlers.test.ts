import { describe, expect, mock, test } from "bun:test";
import { createTab, defaultSession, defaultSettings } from "@jslab/shared";
import { createRpcHandlers, InvalidPayloadError, type RpcHandlerDeps } from "../src/main/rpc-handlers";

function setup() {
  const session = defaultSession(() => createTab({ id: "t1" }));
  const deps = {
    coordinator: {
      start: mock(() => ({ runId: "run-1" })),
      stop: mock(() => {}),
      kill: mock(() => {}),
      wait: mock(() => {}),
      expand: mock(async () => ({ t: "number", v: "1" }) as const),
    },
    settings: { current: defaultSettings() },
    session: {
      session,
      readBuffers: mock(async () => ({ t1: "1 + 1" })),
      setBuffer: mock(() => {}),
      patchTab: mock(async () => {}),
    },
    safeMode: { active: false, reason: null },
    versions: { app: "0.0.1", bun: "1.3.13" },
    log: mock(() => {}),
    onUiHeartbeat: mock(() => {}),
  } satisfies RpcHandlerDeps;
  return { deps, handlers: createRpcHandlers(deps) };
}

const validStart = { tabId: "t1", code: "1 + 1", language: "typescript", logpoints: [], reason: "auto" };

describe("requests", () => {
  test("app.bootstrap returns settings, session, buffers, safe mode and versions", async () => {
    const { handlers, deps } = setup();
    expect(await handlers.requests["app.bootstrap"]()).toEqual({
      settings: deps.settings.current,
      session: deps.session.session,
      buffers: { t1: "1 + 1" },
      safeMode: { active: false, reason: null },
      versions: { app: "0.0.1", bun: "1.3.13" },
    });
  });

  test("run.start validates and forwards only the run fields", () => {
    const { handlers, deps } = setup();
    expect(handlers.requests["run.start"]({ ...validStart, extra: "ignored" })).toEqual({ runId: "run-1" });
    expect(deps.coordinator.start).toHaveBeenCalledWith({
      tabId: "t1",
      code: "1 + 1",
      language: "typescript",
      logpoints: [],
    });
  });

  test("run.start rejects invalid payloads without starting a run", () => {
    const { handlers, deps } = setup();
    expect(() => handlers.requests["run.start"]({ ...validStart, language: "python" })).toThrow(InvalidPayloadError);
    expect(deps.coordinator.start).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalled();
  });

  test("run.expand forwards validated handles", async () => {
    const { handlers, deps } = setup();
    const runId = crypto.randomUUID();
    expect(await handlers.requests["run.expand"]({ tabId: "t1", runId, handleId: "h3" })).toEqual({
      t: "number",
      v: "1",
    });
    expect(deps.coordinator.expand).toHaveBeenCalledWith("t1", runId, "h3");
    expect(() => handlers.requests["run.expand"]({ tabId: "t1", runId, handleId: "nope" })).toThrow(
      InvalidPayloadError,
    );
  });
});

describe("messages", () => {
  test("stop, kill and wait forward the tab id", () => {
    const { handlers, deps } = setup();
    handlers.messages["run.stop"]({ tabId: "t1" });
    handlers.messages["run.kill"]({ tabId: "t1" });
    handlers.messages["run.wait"]({ tabId: "t1" });
    expect(deps.coordinator.stop).toHaveBeenCalledWith("t1");
    expect(deps.coordinator.kill).toHaveBeenCalledWith("t1");
    expect(deps.coordinator.wait).toHaveBeenCalledWith("t1");
  });

  test("invalid messages are logged and dropped instead of throwing", () => {
    const { handlers, deps } = setup();
    expect(() => handlers.messages["run.stop"]({ tabId: 42 })).not.toThrow();
    expect(deps.coordinator.stop).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledTimes(1);
  });

  test("buffer.changed and tab.patch update the session store", () => {
    const { handlers, deps } = setup();
    handlers.messages["buffer.changed"]({ tabId: "t1", content: "const a = 1" });
    handlers.messages["tab.patch"]({ tabId: "t1", patch: { language: "tsx" } });
    expect(deps.session.setBuffer).toHaveBeenCalledWith("t1", "const a = 1");
    expect(deps.session.patchTab).toHaveBeenCalledWith("t1", { language: "tsx" });
  });

  test("ui.heartbeat notifies the watchdog", () => {
    const { handlers, deps } = setup();
    handlers.messages["ui.heartbeat"]();
    expect(deps.onUiHeartbeat).toHaveBeenCalled();
  });

  test("logs a failed tab patch instead of rejecting", async () => {
    const { handlers, deps } = setup();
    deps.session.patchTab = mock(async () => {
      throw new Error("disk full");
    });
    expect(() => handlers.messages["tab.patch"]({ tabId: "t1", patch: { language: "tsx" } })).not.toThrow();
    await Bun.sleep(0);
    expect(deps.log).toHaveBeenCalledWith("Handler for tab.patch failed", "Error: disk full");
  });
});
