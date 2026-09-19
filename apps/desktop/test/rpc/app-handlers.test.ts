import { describe, expect, mock, test } from "bun:test";
import { defaultSettings, type KeybindingRule } from "@jslab/shared";
import { createRedactor } from "../../src/main/logging/redact";
import { appBundlePath, relaunchCommand } from "../../src/main/platform/relaunch";
import {
  type AppHandlerDeps,
  createAppHandlers,
  createSettingsAppHandlers,
  HELP_URLS,
} from "../../src/main/rpc/app-handlers";

/**
 * The keybindings store as `openKeybindingsFile` sees it. Built by a helper rather than mutated in place: under
 * `satisfies AppHandlerDeps` an inline `invalid: false` keeps the literal type `false`, so a test could not set it.
 */
function keybindingsFake(overrides: { rules?: readonly KeybindingRule[]; invalid?: boolean; path?: string } = {}) {
  return {
    path: overrides.path ?? "/data/keybindings.json",
    rules: overrides.rules ?? ([] as readonly KeybindingRule[]),
    invalid: overrides.invalid ?? false,
    save: mock(async (_rules: readonly KeybindingRule[]) => {}),
  };
}

function setup(keybindings = keybindingsFake()) {
  const deps = {
    logTail: mock((_lines: number) => ["a", "Authorization: Bearer secret"]),
    settings: { current: defaultSettings(), reset: mock(async () => defaultSettings()) },
    paths: { dataDir: "/data", logsDir: "/data/logs" },
    keybindings,
    versions: { app: "0.2.0", bun: "1.4.0", electrobun: "2.0.1" },
    os: { macOS: "26.5.2", arch: "arm64" },
    clipboard: mock((_text: string) => {}),
    openPath: mock((_path: string) => {}),
    openExternal: mock((_url: string) => {}),
    restartInSafeMode: mock(() => {}),
    toggleFullScreen: mock(() => {}),
    zoomWindow: mock(() => {}),
    closeWindow: mock(() => {}),
    openSettings: mock(() => {}),
    installCli: mock(() => {}),
    uninstallCli: mock(() => {}),
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
      "zoomWindow",
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
    expect(deps.zoomWindow).toHaveBeenCalledTimes(1);
    expect(deps.closeWindow).toHaveBeenCalledTimes(1);
    expect(deps.openSettings).toHaveBeenCalledTimes(1);
  });

  /**
   * ST-11 (spec §7.4). The URLs are asserted as literals rather than as `HELP_URLS.x` lookups: comparing the
   * handler's output against the very constant the handler read would survive any edit to that constant,
   * including one that pointed a Help item at the wrong page. These three strings were confirmed to return
   * HTTP 200 on the project's repository — a Help item that opens a 404 is worse than one that is absent.
   */
  test("the three Help links each open their page through the one external-link path (ST-11)", () => {
    const { deps, handlers } = setup();
    for (const action of ["openDocumentation", "reportIssue", "openWhatsNew"]) {
      handlers.messages["app.command"]({ action });
    }
    expect(deps.openExternal.mock.calls).toEqual([
      ["https://github.com/GustavoGomez092/js-lab#readme"],
      ["https://github.com/GustavoGomez092/js-lab/issues/new"],
      ["https://github.com/GustavoGomez092/js-lab/releases"],
    ]);
    // A link must never be handed to `openPath`, which would try to open a URL as a filesystem path.
    expect(deps.openPath).not.toHaveBeenCalled();
  });

  test("every Help link is an https URL on the project's own repository (ST-11)", () => {
    // The check above pins three exact strings; this one states the property they have to keep, so a future
    // URL change cannot quietly introduce an http or off-repository link.
    for (const url of Object.values(HELP_URLS)) {
      expect(url.startsWith("https://github.com/GustavoGomez092/js-lab")).toBe(true);
    }
    expect(Object.keys(HELP_URLS).sort()).toEqual(["documentation", "reportIssue", "whatsNew"]);
  });

  test("the Settings window RPC rejects main-window actions such as closeWindow and runs its own (FA-m11)", async () => {
    const { deps } = setup();
    const handlers = createSettingsAppHandlers(deps);
    for (const action of ["closeWindow", "toggleFullScreen", "zoomWindow", "openSettings", "openDataFolder"]) {
      handlers.messages["app.command"]({ action });
    }
    await Bun.sleep(0);
    expect(deps.closeWindow).not.toHaveBeenCalled();
    expect(deps.toggleFullScreen).not.toHaveBeenCalled();
    // Resizing the main window is as much out of the Settings window's reach as closing it (spec §7.5, FA-m11).
    expect(deps.zoomWindow).not.toHaveBeenCalled();
    expect(deps.openSettings).not.toHaveBeenCalled();
    expect(deps.openPath.mock.calls).toEqual([["/data"]]);
    const rejected = (deps.log.mock.calls as unknown[][]).filter(
      (call) => call[0] === "Rejected invalid app.command payload",
    );
    expect(rejected).toHaveLength(4);
  });

  test("installCli and uninstallCli reach Main, and nothing else changes", async () => {
    const { handlers, deps } = setup();
    handlers.messages["app.command"]({ action: "installCli" });
    handlers.messages["app.command"]({ action: "uninstallCli" });
    await Bun.sleep(0);
    expect(deps.installCli).toHaveBeenCalledTimes(1);
    expect(deps.uninstallCli).toHaveBeenCalledTimes(1);
  });

  test("the Settings window can never install the CLI (spec §7.5, §16.1)", async () => {
    const { deps } = setup();
    const handlers = createSettingsAppHandlers(deps);
    handlers.messages["app.command"]({ action: "installCli" });
    handlers.messages["app.command"]({ action: "uninstallCli" });
    await Bun.sleep(0);
    expect(deps.installCli).not.toHaveBeenCalled();
    expect(deps.uninstallCli).not.toHaveBeenCalled();
  });

  // Spec §6.5: Settings → Keybindings offers "Open keybindings.json". On a fresh install the file has never been
  // written, and `openPath` on a missing file shows the user an OS error instead of an editor.
  test("openKeybindingsFile creates the file when there are no overrides yet, then opens it", async () => {
    const { deps } = setup();
    createSettingsAppHandlers(deps).messages["app.command"]({ action: "openKeybindingsFile" });
    await Bun.sleep(0);
    expect(deps.keybindings.save).toHaveBeenCalledWith([]);
    expect(deps.openPath).toHaveBeenCalledWith("/data/keybindings.json");
  });

  test("openKeybindingsFile never rewrites a file that already exists", async () => {
    const withRules = setup(keybindingsFake({ rules: [{ key: "cmd+j", command: "run.start" }] }));
    createSettingsAppHandlers(withRules.deps).messages["app.command"]({ action: "openKeybindingsFile" });
    await Bun.sleep(0);
    expect(withRules.deps.keybindings.save).not.toHaveBeenCalled();
    expect(withRules.deps.openPath).toHaveBeenCalledWith("/data/keybindings.json");

    // `invalid` means the file IS there and failed to parse. Whoever opens it is on their way to repair it by hand,
    // so rewriting it with [] would destroy exactly what they meant to fix.
    const broken = setup(keybindingsFake({ invalid: true }));
    createSettingsAppHandlers(broken.deps).messages["app.command"]({ action: "openKeybindingsFile" });
    await Bun.sleep(0);
    expect(broken.deps.keybindings.save).not.toHaveBeenCalled();
    expect(broken.deps.openPath).toHaveBeenCalledWith("/data/keybindings.json");
  });

  // The path comes from the store, never re-derived here, so this action and the keybindings handlers cannot end up
  // pointing at different files.
  test("openKeybindingsFile opens the store's own path", async () => {
    const { deps } = setup(keybindingsFake({ path: "/elsewhere/keybindings.json" }));
    createSettingsAppHandlers(deps).messages["app.command"]({ action: "openKeybindingsFile" });
    await Bun.sleep(0);
    expect(deps.openPath).toHaveBeenCalledWith("/elsewhere/keybindings.json");
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
