/** Main's steady-state watchdog deadline is 6 s (ui-watchdog.ts); the app heartbeat interval is 2 s. */
export const STARTUP_FAILURE_HEARTBEAT_MS = 2000;

export interface StartupFailureDeps {
  heartbeat(): void;
  reload(): void;
  setInterval?(callback: () => void, ms: number): void;
}

/**
 * Shown when `app.bootstrap` fails, for example on an unreadable buffer (M1 fix wave, final review T12). Before M2
 * the page stayed silent, so Main's watchdog reloaded it every 30 s and it failed again (R-M1-18 N4). It keeps
 * sending heartbeats instead, and the user retries on purpose. Strings stay here: `strings.ts` arrives in Task 13.
 */
export function showStartupFailure(root: HTMLElement, error: unknown, deps: StartupFailureDeps): void {
  const message = error instanceof Error ? error.message : String(error);
  const box = document.createElement("div");
  box.className = "startup-failure";
  box.setAttribute("role", "alert");
  const text = document.createElement("p");
  text.textContent = `JSLab failed to start: ${message}`;
  const retry = document.createElement("button");
  retry.type = "button";
  retry.textContent = "Try Again";
  retry.addEventListener("click", () => deps.reload());
  box.append(text, retry);
  root.replaceChildren(box);
  deps.heartbeat();
  const every = deps.setInterval ?? ((callback: () => void, ms: number) => void window.setInterval(callback, ms));
  every(() => deps.heartbeat(), STARTUP_FAILURE_HEARTBEAT_MS);
}
