import { describe, expect, mock, test } from "bun:test";
import { defaultSettings } from "@jslab/shared";
import { createRedactor } from "../../src/main/logging/redact";
import { appBundlePath, relaunchCommand } from "../../src/main/platform/relaunch";
import { type AppHandlerDeps, createAppHandlers } from "../../src/main/rpc/app-handlers";

function setup() {
  const deps = {
    logTail: mock((_lines: number) => ["a", "Authorization: Bearer secret"]),
    settings: { current: defaultSettings(), reset: mock(async () => defaultSettings()) },
    paths: { dataDir: "/data", logsDir: "/data/logs" },
    versions: { app: "0.2.0", bun: "1.4.0", electrobun: "2.0.1" },
    os: { macOS: "26.5.2", arch: "arm64" },
    clipboard: mock((_text: string) => {}),
    openPath: mock((_path: string) => {}),
    restartInSafeMode: mock(() => {}),
    toggleFullScreen: mock(() => {}),
    closeWindow: mock(() => {}),
    openSettings: mock(() => {}),
    redact: createRedactor(),
    log: mock(() => {}),
  } satisfies AppHandlerDeps;
  return { deps, handlers: createAppHandlers(deps) };
}

describe("app.command", () => {
  test("copyDebugLog copies a redacted report with the recent log", () => {
    const { deps, handlers } = setup();
    handlers.messages["app.command"]({ action: "copyDebugLog" });
    expect(deps.logTail).toHaveBeenCalledWith(500);
    const text = deps.clipboard.mock.calls[0]?.[0] ?? "";
    expect(JSON.parse(text).log).toEqual(["a", "Authorization: [REDACTED]"]);
  });

  test("folder, reset, restart and full-screen actions reach their adapters", async () => {
    const { deps, handlers } = setup();
    for (const action of [
      "openLogsFolder",
      "openDataFolder",
      "resetSettings",
      "restartSafeMode",
      "toggleFullScreen",
      "closeWindow",
      "openSettings",
    ]) {
      handlers.messages["app.command"]({ action });
    }
    await Bun.sleep(0);
    expect(deps.openPath.mock.calls).toEqual([["/data/logs"], ["/data"]]);
    expect(deps.settings.reset).toHaveBeenCalledTimes(1);
    expect(deps.restartInSafeMode).toHaveBeenCalledTimes(1);
    expect(deps.toggleFullScreen).toHaveBeenCalledTimes(1);
    expect(deps.closeWindow).toHaveBeenCalledTimes(1);
    expect(deps.openSettings).toHaveBeenCalledTimes(1);
  });

  test("unknown actions are logged and dropped", () => {
    const { deps, handlers } = setup();
    handlers.messages["app.command"]({ action: "rm -rf" });
    expect(deps.log).toHaveBeenCalledTimes(1);
    expect(deps.clipboard).not.toHaveBeenCalled();
  });

  test("relaunch targets the enclosing .app bundle and waits (capped) for the old pid to exit (m-5)", () => {
    expect(appBundlePath("/Applications/JSLab.app/Contents/Resources")).toBe("/Applications/JSLab.app");
    expect(appBundlePath("/usr/local/lib")).toBeNull();
    expect(relaunchCommand('/Apps/JSLab "x".app', 4242)).toEqual([
      "/bin/sh",
      "-c",
      'i=0; while kill -0 "$2" 2>/dev/null && [ "$i" -lt 150 ]; do sleep 0.2; i=$((i+1)); done; /usr/bin/open -n "$1"',
      "jslab-relaunch",
      '/Apps/JSLab "x".app',
      "4242",
    ]);
  });
});
