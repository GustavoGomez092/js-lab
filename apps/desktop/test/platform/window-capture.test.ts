import { describe, expect, mock, test } from "bun:test";
import {
  captureWindow,
  SCREEN_RECORDING_SKIP,
  screencaptureArgs,
  windowNumberOf,
} from "../../src/main/platform/window-capture";

describe("window capture", () => {
  test("captures one window without shadow or sound, never the full screen", () => {
    expect(screencaptureArgs(4242, "/out/a.png")).toEqual(["screencapture", "-x", "-o", "-l", "4242", "/out/a.png"]);
    expect(() => screencaptureArgs(0, "/out/a.png")).toThrow(/refusing to capture the full screen/);
    expect(() => screencaptureArgs(Number.NaN, "/out/a.png")).toThrow(/refusing/);
  });

  test("a missing window pointer has no window number", () => {
    expect(windowNumberOf(null)).toBeNull();
  });

  test("without Screen Recording access the capture is skipped before screencapture runs", async () => {
    const hasAccess = mock(() => false);
    expect(await captureWindow(4242, "/out/a.png", hasAccess)).toEqual({ skipped: SCREEN_RECORDING_SKIP });
    expect(SCREEN_RECORDING_SKIP).toBe("no screen-recording permission");
    expect(hasAccess).toHaveBeenCalledTimes(1);
  });
});
