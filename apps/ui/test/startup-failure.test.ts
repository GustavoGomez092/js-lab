import { describe, expect, mock, test } from "bun:test";
import { STARTUP_FAILURE_HEARTBEAT_MS, showStartupFailure } from "../src/shell/startup-failure";
import { strings } from "../src/strings";

describe("startup failure (R-M1-18 N4)", () => {
  test("shows the error with Try Again and keeps Main's watchdog fed", () => {
    const root = document.createElement("div");
    const ticks: [() => void, number][] = [];
    const heartbeat = mock(() => {});
    const reload = mock(() => {});
    showStartupFailure(root, new Error("Couldn't read the buffer for tab t1: EACCES"), {
      heartbeat,
      reload,
      setInterval: (callback, ms) => {
        ticks.push([callback, ms]);
      },
    });
    expect(root.querySelector('[role="alert"]')?.textContent).toContain(
      strings.startup.failed("Couldn't read the buffer for tab t1: EACCES"),
    );
    expect(root.querySelector("button")?.textContent).toBe(strings.startup.retry);
    expect(heartbeat).toHaveBeenCalledTimes(1);
    expect(ticks.map(([, ms]) => ms)).toEqual([STARTUP_FAILURE_HEARTBEAT_MS]);
    ticks[0]?.[0]();
    expect(heartbeat).toHaveBeenCalledTimes(2);
    root.querySelector("button")?.click();
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
