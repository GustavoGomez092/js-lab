/** How long the UI gets to send its first heartbeat before the boot-grace watchdog kicks in (I1). */
export const UI_BOOT_TIMEOUT_MS = 30_000;

/** How long the UI can go without a heartbeat, once it has sent at least one, before we reload it (spec §4.6). */
export const UI_HEARTBEAT_TIMEOUT_MS = 6_000;

export interface ShouldReloadViewInput {
  now: number;
  /** When the current boot window started (process start, or the last reload while still waiting on a first heartbeat). */
  startedAt: number;
  lastHeartbeat: number;
  sawFirstHeartbeat: boolean;
}

/**
 * A cold start can legitimately take longer than the steady-state heartbeat deadline (WKWebView init, bundle
 * load, etc.), so the first heartbeat gets a longer boot grace period; only once it has arrived does the
 * shorter steady-state deadline apply (I1).
 */
export function shouldReloadView({ now, startedAt, lastHeartbeat, sawFirstHeartbeat }: ShouldReloadViewInput): boolean {
  if (!sawFirstHeartbeat) return now - startedAt > UI_BOOT_TIMEOUT_MS;
  return now - lastHeartbeat > UI_HEARTBEAT_TIMEOUT_MS;
}

export interface WatchdogState {
  sawFirstHeartbeat: boolean;
  bootWindowStartedAt: number;
  lastUiHeartbeat: number;
}

/**
 * A view the watchdog reloads, or a window that is newly created (a Dock reopen), boots from scratch: it gets the
 * 30 s boot grace until its own first heartbeat, not the 6 s steady-state deadline left over from the previous view
 * (R-M2-T18-3).
 */
export function onReload(now: number): WatchdogState {
  return { sawFirstHeartbeat: false, bootWindowStartedAt: now, lastUiHeartbeat: now };
}
