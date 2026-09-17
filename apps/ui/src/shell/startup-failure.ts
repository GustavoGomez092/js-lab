import type { AppAction } from "@jslab/rpc-schema";
import { strings } from "../strings";

/** Main's steady-state watchdog deadline is 6 s (ui-watchdog.ts); the app heartbeat interval is 2 s. */
export const STARTUP_FAILURE_HEARTBEAT_MS = 2000;

/** The app actions this screen offers. Both reach Main as fire-and-forget messages, so neither can time out. */
export const STARTUP_FAILURE_ACTIONS = ["openDataFolder", "copyDebugLog"] as const satisfies readonly AppAction[];

export interface StartupFailureDeps {
  heartbeat(): void;
  reload(): void;
  appCommand(action: AppAction): void;
  setInterval?(callback: () => void, ms: number): void;
}

/**
 * Shown when `app.bootstrap` fails, for example on an unreadable buffer (M1 fix wave, final review T12). Before M2
 * the page stayed silent, so Main's watchdog reloaded it every 30 s and it failed again (R-M1-18 N4). It keeps
 * sending heartbeats instead, and the user retries on purpose. `strings.ts` has no imports, so this path still
 * renders when the rest of the app failed to load.
 *
 * F1: Try Again re-runs the *identical* bootstrap, so for any failure that isn't transient it is an infinite loop
 * whose only escape was deleting buffer files by hand. It stays -- a transient failure is worth one more try --
 * but it is no longer the only control: Open Data Folder puts the user in front of the files that failed to load,
 * and Copy Debug Log gets them a report. Both are `app.command` messages, not requests, so neither can itself
 * time out on the way to Main.
 */
export function showStartupFailure(root: HTMLElement, error: unknown, deps: StartupFailureDeps): void {
  const message = error instanceof Error ? error.message : String(error);
  const box = document.createElement("div");
  box.className = "startup-failure";
  box.setAttribute("role", "alert");
  const text = document.createElement("p");
  text.textContent = strings.startup.failed(message);
  const retry = document.createElement("button");
  retry.type = "button";
  retry.textContent = strings.startup.retry;
  retry.addEventListener("click", () => deps.reload());

  const hint = document.createElement("p");
  hint.className = "startup-failure-hint";
  hint.textContent = strings.startup.stuck;

  const openDataFolder = document.createElement("button");
  openDataFolder.type = "button";
  openDataFolder.textContent = strings.startup.openDataFolder;
  openDataFolder.addEventListener("click", () => deps.appCommand("openDataFolder"));

  const copyDebugLog = document.createElement("button");
  copyDebugLog.type = "button";
  copyDebugLog.textContent = strings.startup.copyDebugLog;
  copyDebugLog.addEventListener("click", () => deps.appCommand("copyDebugLog"));

  box.append(text, retry, hint, openDataFolder, copyDebugLog);
  root.replaceChildren(box);
  deps.heartbeat();
  const every = deps.setInterval ?? ((callback: () => void, ms: number) => void window.setInterval(callback, ms));
  every(() => deps.heartbeat(), STARTUP_FAILURE_HEARTBEAT_MS);
}
