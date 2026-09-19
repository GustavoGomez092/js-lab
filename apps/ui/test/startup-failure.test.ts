import { describe, expect, mock, test } from "bun:test";
import { STARTUP_FAILURE_HEARTBEAT_MS, showStartupFailure } from "../src/shell/startup-failure";
import { strings } from "../src/strings";

function show(overrides: { appCommand?: (action: never) => void } = {}) {
  const root = document.createElement("div");
  const ticks: [() => void, number][] = [];
  const heartbeat = mock(() => {});
  const reload = mock(() => {});
  const appCommand = mock((_action: string) => {});
  showStartupFailure(root, new Error("Couldn't read the buffer for tab t1: EACCES"), {
    heartbeat,
    reload,
    appCommand: (overrides.appCommand ?? appCommand) as (action: never) => void,
    setInterval: (callback, ms) => {
      ticks.push([callback, ms]);
    },
  });
  return { root, ticks, heartbeat, reload, appCommand };
}

const labelled = (root: HTMLElement, label: string) =>
  [...root.querySelectorAll("button")].find((button) => button.textContent === label);

describe("startup failure (R-M1-18 N4)", () => {
  test("shows the error with Try Again and keeps Main's watchdog fed", () => {
    const { root, ticks, heartbeat, reload } = show();
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

  /**
   * F1: Try Again re-runs the identical bootstrap, so for a non-transient failure it is an infinite loop. The
   * screen must offer at least one control that does something *other* than repeat the request that just failed.
   */
  test("offers actions that do something other than re-run the failing bootstrap", () => {
    const { root, appCommand, reload } = show();
    expect(root.textContent).toContain(strings.startup.stuck);

    labelled(root, strings.startup.openDataFolder)?.click();
    expect(appCommand).toHaveBeenLastCalledWith("openDataFolder");

    labelled(root, strings.startup.copyDebugLog)?.click();
    expect(appCommand).toHaveBeenLastCalledWith("copyDebugLog");

    // Neither escape hatch is a reload: the point is that they are not the same operation.
    expect(reload).not.toHaveBeenCalled();
    expect(appCommand).toHaveBeenCalledTimes(2);
  });
});
