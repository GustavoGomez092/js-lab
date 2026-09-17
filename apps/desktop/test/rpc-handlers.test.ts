import { describe, expect, mock, test } from "bun:test";
import { createTab, defaultSession, defaultSettings } from "@jslab/shared";
import { createRpcHandlers, InvalidPayloadError, type RpcHandlerDeps, RunRefusedError } from "../src/main/rpc-handlers";

function setup(safeMode: RpcHandlerDeps["safeMode"] = { active: false, reason: null }) {
  const session = defaultSession(() => createTab({ id: "t1" }));
  const deps = {
    coordinator: {
      start: mock(() => ({ runId: "run-1" })),
      stop: mock(() => {}),
      kill: mock(() => {}),
      wait: mock(() => {}),
      expand: mock(async () => ({ t: "number", v: "1" }) as const),
      mute: mock(() => {}),
    },
    settings: { current: defaultSettings() },
    session: {
      session,
      readBuffers: mock(async () => ({ t1: "1 + 1" })),
      setBuffer: mock(() => {}),
      patchTab: mock(async () => {}),
    },
    safeMode,
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
      // The default tab's runtime is DEFAULT_RUNTIME, which M4 Task 9a returned to "bun": with the browser
      // runtimes actually registered, a default tab would otherwise route to a web view that starts evaluating
      // and never reports a result (see packages/shared/src/settings.ts).
      runtime: "bun",
      workingDirectory: null,
      scriptName: "1 + 1.ts",
      // Task 15: the default tab has no saved mute preference, so this is its schema default.
      muted: false,
    });
  });

  // Task 15 (spec §5.12, EX-35): a muted tab's next run starts muted, not just its saved layout -- every web run
  // gets a fresh realm, so this is what keeps a muted tab muted across Auto Run.
  test("run.start carries the tab's saved mute preference", () => {
    const { handlers, deps } = setup();
    const tab = deps.session.session.tabs.t1;
    if (!tab) throw new Error("expected tab t1");
    deps.session.session.tabs.t1 = { ...tab, layout: { ...tab.layout, muted: true } };
    handlers.requests["run.start"](validStart);
    expect(deps.coordinator.start).toHaveBeenCalledWith(expect.objectContaining({ muted: true }));
  });

  test("run.start rejects invalid payloads without starting a run", () => {
    const { handlers, deps } = setup();
    expect(() => handlers.requests["run.start"]({ ...validStart, language: "python" })).toThrow(InvalidPayloadError);
    expect(deps.coordinator.start).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalled();
  });

  test("run.start refuses automatic runs while Safe Mode is active but allows manual runs", () => {
    const { handlers, deps } = setup({ active: true, reason: "crashLoop" });
    expect(() => handlers.requests["run.start"](validStart)).toThrow(RunRefusedError);
    expect(deps.coordinator.start).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalled();
    expect(handlers.requests["run.start"]({ ...validStart, reason: "manual" })).toEqual({ runId: "run-1" });
    expect(deps.coordinator.start).toHaveBeenCalledTimes(1);
  });

  test("run.start reads the tab's runtime and forwards the effective runtime (M4 T1)", () => {
    const { handlers, deps } = setup();
    deps.session.session.tabs.t1 = {
      ...(deps.session.session.tabs.t1 as NonNullable<(typeof deps.session.session.tabs)["t1"]>),
      runtime: "browser",
    };
    handlers.requests["run.start"](validStart);
    // Every runtime is available since M4 Task 9, so effectiveRuntime forwards the tab's own runtime unchanged.
    expect(deps.coordinator.start).toHaveBeenCalledWith(expect.objectContaining({ runtime: "browser" }));
  });

  test("run.start prefers the tab's runtime over the request's when they differ -- the tab is the source of truth (R-M4-T1-MINOR-1, M4 T9)", () => {
    const { handlers, deps } = setup();
    deps.session.session.tabs.t1 = {
      ...(deps.session.session.tabs.t1 as NonNullable<(typeof deps.session.session.tabs)["t1"]>),
      runtime: "browser",
    };
    // The request explicitly carries "bun" -- a stale UI copy of the tab's runtime (M4 T1's own comment on
    // rpc-handlers.ts). Task 1's precedence test couldn't distinguish tab-wins from request-wins because every
    // runtime collapsed to "bun" regardless of which source won; now that AVAILABLE_RUNTIMES holds all three
    // (Task 9), a divergent request proves it for real: the tab starts on "browser", not the request's "bun".
    handlers.requests["run.start"]({ ...validStart, runtime: "bun" });
    expect(deps.coordinator.start).toHaveBeenCalledWith(expect.objectContaining({ runtime: "browser" }));
  });

  test("run.expand forwards validated handles", async () => {
    const { handlers, deps } = setup();
    const runId = crypto.randomUUID();
    expect(await handlers.requests["run.expand"]({ tabId: "t1", runId, handleId: "h3" })).toEqual({
      t: "number",
      v: "1",
    });
    // OU-02: the handler now forwards a fourth argument, `offset`, which is `undefined` for a caller that sent
    // none -- so the expectation names four arguments even though only three were on the request.
    expect(deps.coordinator.expand).toHaveBeenCalledWith("t1", runId, "h3", undefined);
    expect(() => handlers.requests["run.expand"]({ tabId: "t1", runId, handleId: "nope" })).toThrow(
      InvalidPayloadError,
    );
  });

  test("run.expand forwards the offset, and omits it when the caller sent none (OU-02)", async () => {
    const { handlers, deps } = setup();
    const runId = crypto.randomUUID();
    await handlers.requests["run.expand"]({ tabId: "t1", runId, handleId: "h3", offset: 10_000 });
    expect(deps.coordinator.expand).toHaveBeenLastCalledWith("t1", runId, "h3", 10_000);
    await handlers.requests["run.expand"]({ tabId: "t1", runId, handleId: "h3" });
    expect(deps.coordinator.expand).toHaveBeenLastCalledWith("t1", runId, "h3", undefined);
    // The schema, not the handler, is what refuses a malformed offset -- and it refuses it before the coordinator
    // is reached at all, which the call count proves.
    expect(() => handlers.requests["run.expand"]({ tabId: "t1", runId, handleId: "h3", offset: -1 })).toThrow(
      InvalidPayloadError,
    );
    expect(() => handlers.requests["run.expand"]({ tabId: "t1", runId, handleId: "h3", offset: 1.5 })).toThrow(
      InvalidPayloadError,
    );
    expect(deps.coordinator.expand).toHaveBeenCalledTimes(2);
  });

  test("run.start passes the tab's working directory and script name from the session (spec §5.3)", () => {
    const { handlers, deps } = setup();
    deps.session.session.tabs.t1 = {
      ...(deps.session.session.tabs.t1 as NonNullable<(typeof deps.session.session.tabs)["t1"]>),
      workingDirectory: "/work/api",
      title: "fetch users",
      titleIsCustom: true,
    };
    handlers.requests["run.start"](validStart);
    expect(deps.coordinator.start).toHaveBeenCalledWith(
      expect.objectContaining({ workingDirectory: "/work/api", scriptName: "fetch users.ts" }),
    );
  });

  test("run.start names the script from the request's language and falls back for an unknown tab", () => {
    const { handlers, deps } = setup();
    deps.session.session.tabs.t1 = {
      ...(deps.session.session.tabs.t1 as NonNullable<(typeof deps.session.session.tabs)["t1"]>),
      language: "typescript",
      workingDirectory: "/work/api",
      title: "fetch users",
      titleIsCustom: true,
    };
    handlers.requests["run.start"]({ ...validStart, language: "javascript" });
    expect(deps.coordinator.start).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ workingDirectory: "/work/api", scriptName: "fetch users.js" }),
    );
    expect(deps.session.session.tabs.t9).toBeUndefined();
    handlers.requests["run.start"]({ ...validStart, tabId: "t9" });
    expect(deps.coordinator.start).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ tabId: "t9", workingDirectory: null, scriptName: "Untitled.ts" }),
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

  // Task 15 (spec §5.12, EX-35, fix round 1 F2): a mute toggle takes effect on whatever is running right now
  // too, not just the tab's saved layout -- but only when `muted` actually changed. The UI's sole producer of
  // tab.patch (apps/ui/src/shell/tab-patch.ts's computeTabPatch) always sends the *entire* layout object
  // whenever anything tracked in it changed, so a patch shaped `{ title: "x" }` alone (what the old version of
  // this test used) never happens in production -- `layout` rides along on every patch. This uses the shape
  // production actually sends.
  test("tab.patch's layout.muted live-mutes whatever is currently running, but only on an actual change", () => {
    const { handlers, deps } = setup();
    const layout = deps.session.session.tabs.t1?.layout;
    if (!layout) throw new Error("expected tab t1");

    // A rename: the whole (unchanged) layout rides along, `muted` included -- must not call coordinator.mute.
    handlers.messages["tab.patch"]({ tabId: "t1", patch: { title: "x", layout } });
    expect(deps.coordinator.mute).not.toHaveBeenCalled();

    // An actual mute toggle: same shape, `muted` this time genuinely differs from what's stored.
    handlers.messages["tab.patch"]({ tabId: "t1", patch: { title: "y", layout: { ...layout, muted: true } } });
    expect(deps.coordinator.mute).toHaveBeenCalledWith("t1", true);
    expect(deps.coordinator.mute).toHaveBeenCalledTimes(1);
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

  test("e2e.response is validated before reaching the bridge", () => {
    const { deps } = setup();
    const onE2EResponse = mock(() => {});
    const handlers = createRpcHandlers({ ...deps, e2e: true, onE2EResponse });
    handlers.messages["e2e.response"]({ reqId: 3, ok: true, result: 1 });
    handlers.messages["e2e.response"]({ reqId: "3", ok: true });
    expect(onE2EResponse).toHaveBeenCalledTimes(1);
    expect(onE2EResponse).toHaveBeenCalledWith({ reqId: 3, ok: true, result: 1 });
  });
});
