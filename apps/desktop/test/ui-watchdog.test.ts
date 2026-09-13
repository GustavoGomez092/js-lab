import { describe, expect, test } from "bun:test";
import { shouldReloadView } from "../src/main/ui-watchdog";

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
});
