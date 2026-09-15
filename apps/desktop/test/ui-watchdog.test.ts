import { describe, expect, test } from "bun:test";
import { onReload, shouldReloadView } from "../src/main/ui-watchdog";

describe("shouldReloadView", () => {
  test("waits for the boot deadline before the first heartbeat", () => {
    expect(shouldReloadView({ now: 10_000, startedAt: 0, lastHeartbeat: 0, sawFirstHeartbeat: false })).toBe(false);
    expect(shouldReloadView({ now: 30_001, startedAt: 0, lastHeartbeat: 0, sawFirstHeartbeat: false })).toBe(true);
  });

  test("uses the 6 second deadline after the first heartbeat", () => {
    expect(shouldReloadView({ now: 105_999, startedAt: 0, lastHeartbeat: 100_000, sawFirstHeartbeat: true })).toBe(
      false,
    );
    expect(shouldReloadView({ now: 106_001, startedAt: 0, lastHeartbeat: 100_000, sawFirstHeartbeat: true })).toBe(
      true,
    );
  });

  test("a reloaded or newly created view is a fresh boot with the 30 second grace (R-M2-T18-3)", () => {
    // Steady state: heartbeats arrived, then the UI stalled past the 6 s deadline and the watchdog reloads at 200 s.
    const reloaded = onReload(200_000);
    expect(reloaded).toEqual({ sawFirstHeartbeat: false, bootWindowStartedAt: 200_000, lastUiHeartbeat: 200_000 });
    const at = (now: number) =>
      shouldReloadView({
        now,
        startedAt: reloaded.bootWindowStartedAt,
        lastHeartbeat: reloaded.lastUiHeartbeat,
        sawFirstHeartbeat: reloaded.sawFirstHeartbeat,
      });
    expect([at(206_001), at(230_000), at(230_001)]).toEqual([false, false, true]);
  });
});
