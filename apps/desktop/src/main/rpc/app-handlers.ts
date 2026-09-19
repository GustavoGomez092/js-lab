import { homedir } from "node:os";
import { type AppAction, appCommandSchema, settingsAppCommandSchema } from "@jslab/rpc-schema";
import { buildDebugReport } from "../logging/debug-report";
import type { Redactor } from "../logging/redact";
import type { KeybindingsStore } from "../services/keybindings-store";
import type { SettingsStore } from "../services/settings-store";
import { createValidators, type Log } from "./validate";

export interface AppHandlerDeps {
  logTail(lines: number): string[];
  settings: Pick<SettingsStore, "current" | "reset">;
  paths: { dataDir: string; logsDir: string };
  /**
   * Settings → Keybindings "Open keybindings.json" (spec §6.5). The store owns the path, so this action and the
   * keybindings handlers can never disagree about which file they mean.
   */
  keybindings: Pick<KeybindingsStore, "path" | "rules" | "save" | "invalid">;
  versions: { app: string; bun: string; electrobun: string };
  os: { macOS: string; arch: string };
  clipboard(text: string): void;
  openPath(path: string): void;
  restartInSafeMode(): void;
  toggleFullScreen(): void;
  /** Standard macOS zoom: fill the display's work area, or go back to the pre-zoom frame. Never full screen. */
  zoomWindow(): void;
  closeWindow(): void;
  openSettings(): void;
  /** Spec §16.1: Help → Install `jslab` Command…. Defaults to ~/.local/bin and never escalates. */
  installCli(): void;
  uninstallCli(): void;
  redact: Redactor;
  /** The home folder written as `~` in the debug report (FA-m12); defaults to `os.homedir()`. */
  home?: string;
  log: Log;
}

/** Help menu and window-level actions that need Main (spec §7.4, §8 Advanced, §20). */
export function createAppHandlers(deps: AppHandlerDeps) {
  const { message } = createValidators(deps.log);
  return {
    requests: {},
    messages: {
      "app.command": message(appCommandSchema, "app.command", ({ action }) => runAppAction(deps, action)),
    },
  };
}

/**
 * The Settings window's `app.command` (spec §7.5, FA-m11): the same handler body, but only the actions the Settings UI
 * sends. Main-window actions such as closeWindow are rejected and logged like any invalid payload.
 */
export function createSettingsAppHandlers(deps: AppHandlerDeps) {
  const { message } = createValidators(deps.log);
  return {
    requests: {},
    messages: {
      "app.command": message(settingsAppCommandSchema, "app.command", ({ action }) => runAppAction(deps, action)),
    },
  };
}

async function runAppAction(deps: AppHandlerDeps, action: AppAction): Promise<void> {
  switch (action) {
    case "copyDebugLog":
      deps.clipboard(
        buildDebugReport({
          versions: deps.versions,
          os: deps.os,
          settings: deps.settings.current,
          logLines: deps.logTail(500),
          redact: deps.redact,
          home: deps.home ?? homedir(),
        }),
      );
      return;
    case "openLogsFolder":
      deps.openPath(deps.paths.logsDir);
      return;
    case "openDataFolder":
      deps.openPath(deps.paths.dataDir);
      return;
    case "resetSettings":
      await deps.settings.reset();
      return;
    case "restartSafeMode":
      deps.restartInSafeMode();
      return;
    case "toggleFullScreen":
      deps.toggleFullScreen();
      return;
    case "zoomWindow":
      deps.zoomWindow();
      return;
    case "closeWindow":
      deps.closeWindow();
      return;
    case "openSettings":
      deps.openSettings();
      return;
    case "installCli":
      deps.installCli();
      return;
    case "uninstallCli":
      deps.uninstallCli();
      return;
    case "openKeybindingsFile":
      // A fresh install has never written keybindings.json, and `openPath` on a missing file gives the user an OS
      // error instead of an editor. Writing the empty override set first is idempotent and leaves the running app
      // exactly as it was. A file that exists but failed to parse is deliberately NEVER rewritten: `invalid` means
      // the file is there and unreadable, and someone opening it is on their way to repair it by hand -- rewriting
      // it would destroy the very thing they meant to fix.
      if (deps.keybindings.rules.length === 0 && !deps.keybindings.invalid) await deps.keybindings.save([]);
      deps.openPath(deps.keybindings.path);
      return;
  }
}
