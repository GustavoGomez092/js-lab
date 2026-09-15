import { describe, expect, mock, test } from "bun:test";
import { createErrorPolicy } from "../src/main/error-policy";

function setup() {
  let releaseDialog: () => void = () => {};
  const deps = {
    log: mock((_message: string, _detail?: unknown) => {}),
    showFatal: mock((_message: string) => new Promise<void>((resolve) => (releaseDialog = resolve))),
    quit: mock((_code: number) => {}),
    notify: mock(() => {}),
  };
  return { deps, policy: createErrorPolicy(deps), releaseDialog: () => releaseDialog() };
}

describe("Main error policy (spec §20, FA-I3)", () => {
  test("before startup finishes, an uncaught error fails fast: one dialog and one quit with code 1, however many arrive", async () => {
    const { deps, policy, releaseDialog } = setup();
    policy.onUncaught("exception", new Error("boom"));
    // start().catch(fail) racing the listener, and a second uncaught error while the dialog is up.
    const second = policy.fail(new Error("start failed"));
    policy.onUncaught("rejection", new Error("later"));
    expect(deps.showFatal.mock.calls).toEqual([["boom"]]);
    expect(deps.quit).not.toHaveBeenCalled();
    releaseDialog();
    await second;
    await Bun.sleep(0);
    expect(deps.quit.mock.calls).toEqual([[1]]);
    expect(policy.exitCode).toBe(1);
    expect(deps.notify).not.toHaveBeenCalled();
  });

  test("after startup, uncaught exceptions and rejections are logged and shown as a notice, and the app keeps running", () => {
    const { deps, policy } = setup();
    policy.markStarted();
    policy.onUncaught("exception", new Error("menu timer failed"));
    policy.onUncaught("rejection", "font scan failed");
    expect(deps.log.mock.calls.map(([message]) => message)).toEqual(["Uncaught exception", "Unhandled rejection"]);
    expect(deps.notify).toHaveBeenCalledTimes(2);
    expect(deps.showFatal).not.toHaveBeenCalled();
    expect(deps.quit).not.toHaveBeenCalled();
    expect(policy.exitCode).toBe(0);
  });

  test("a failure dialog that can't be shown still quits with code 1, and a notice that throws is only logged", async () => {
    const { deps, policy } = setup();
    deps.showFatal.mockImplementation(async () => {
      throw new Error("no native dialog");
    });
    await policy.fail("bad");
    expect(deps.quit.mock.calls).toEqual([[1]]);

    const started = setup();
    started.deps.notify.mockImplementation(() => {
      throw new Error("window gone");
    });
    started.policy.markStarted();
    expect(() => started.policy.onUncaught("exception", new Error("x"))).not.toThrow();
    expect(started.deps.log.mock.calls.map(([message]) => message)).toEqual([
      "Uncaught exception",
      "Couldn't show the unexpected-error notice",
    ]);
  });

  test("a throwing log call before startup still shows the dialog and quits exactly once (RR1-m3)", async () => {
    const { deps, policy, releaseDialog } = setup();
    deps.log.mockImplementationOnce(() => {
      throw new Error("logger unavailable");
    });
    const failing = policy.fail(new Error("boom"));
    releaseDialog();
    await failing;
    expect(deps.quit.mock.calls).toEqual([[1]]);
    expect(deps.showFatal.mock.calls).toEqual([["boom"]]);
    expect(policy.exitCode).toBe(1);
  });
});
