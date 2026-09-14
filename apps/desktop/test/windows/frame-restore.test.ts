import { describe, expect, test } from "bun:test";
import { DEFAULT_FRAME, displayForFrame, frameToSave, restoreFrame } from "../../src/main/windows/frame-restore";

// A built-in display below a 25 pt menu bar, and an external display to its right.
const primary = {
  id: 1,
  isPrimary: true,
  bounds: { x: 0, y: 0, width: 1512, height: 982 },
  workArea: { x: 0, y: 25, width: 1512, height: 920 },
};
const external = {
  id: 2,
  isPrimary: false,
  bounds: { x: 1512, y: 0, width: 2560, height: 1440 },
  workArea: { x: 1512, y: 0, width: 2560, height: 1415 },
};

describe("frame persistence edge cases (FA-m6)", () => {
  test("a frame centered over the menu bar or Dock strip falls back to the display it overlaps most", () => {
    // Center (756, 10) is in the primary display's menu bar: inside its bounds, outside its work area.
    expect(displayForFrame({ x: 556, y: -140, width: 400, height: 300 }, [primary, external])?.id).toBe(1);
    // Mostly on the external display, centered in the gap below its work area.
    expect(displayForFrame({ x: 1600, y: 1300, width: 800, height: 260 }, [primary, external])?.id).toBe(2);
    expect(displayForFrame({ x: -5000, y: 0, width: 400, height: 300 }, [primary, external])).toBeNull();
  });

  test("no displayId, frame on an existing display: restored there, clamped into its work area", () => {
    expect(restoreFrame({ x: 1400, y: -50, width: 3000, height: 800 }, [primary, external]).frame).toEqual({
      x: 1512,
      y: 0,
      width: 2560,
      height: 800,
    });
    expect(restoreFrame({ x: 100, y: 10, width: 800, height: 600 }, [primary, external]).frame).toEqual({
      x: 100,
      y: 25,
      width: 800,
      height: 600,
    });
  });

  test("the first full-screen toggle with no saved frame keeps the current frame; later ones keep the windowed frame", () => {
    const frame = { x: 10, y: 40, width: 900, height: 700 };
    expect(frameToSave({ fullScreen: true, frame, previous: null, displays: [primary] })).toEqual({
      ...frame,
      displayId: "1",
      fullscreen: true,
    });
    const previous = { x: 5, y: 30, width: 1000, height: 800, displayId: "1", fullscreen: false };
    expect(
      frameToSave({ fullScreen: true, frame: { x: 0, y: 0, width: 1512, height: 982 }, previous, displays: [primary] }),
    ).toEqual({ ...previous, fullscreen: true });
    expect(frameToSave({ fullScreen: false, frame, previous, displays: [primary] })).toEqual({
      ...frame,
      displayId: "1",
      fullscreen: false,
    });
    expect(frameToSave({ fullScreen: false, frame: { ...frame, x: -9000 }, previous, displays: [primary] })).toEqual({
      ...frame,
      x: -9000,
      fullscreen: false,
    });
  });
});

describe("frame restore (spec §10.1)", () => {
  test("a frame whose display still exists is restored there, clamped into its work area", () => {
    expect(
      restoreFrame({ x: 1700, y: 100, width: 1200, height: 800, displayId: "2", fullscreen: true }, [
        primary,
        external,
      ]),
    ).toEqual({
      frame: { x: 1700, y: 100, width: 1200, height: 800 },
      fullscreen: true,
    });
    expect(
      restoreFrame({ x: 1400, y: -50, width: 3000, height: 800, displayId: "1" }, [primary, external]).frame,
    ).toEqual({
      x: 0,
      y: 25,
      width: 1512,
      height: 800,
    });
  });

  test("a missing display, or an off-screen frame without a display id, is centered on the primary display", () => {
    expect(restoreFrame({ x: 1700, y: 100, width: 1200, height: 800, displayId: "7" }, [primary]).frame).toEqual({
      x: 156,
      y: 85,
      width: 1200,
      height: 800,
    });
    expect(restoreFrame({ x: -40000, y: -40000, width: 900, height: 600 }, [primary, external])).toEqual({
      frame: { x: 306, y: 185, width: 900, height: 600 },
      fullscreen: false,
    });
  });

  test("no saved frame centers the default size; no display information keeps the saved frame; ids come from the center", () => {
    expect(restoreFrame(null, [primary, external]).frame).toEqual({ x: 116, y: 75, width: 1280, height: 820 });
    expect(restoreFrame(null, [])).toEqual({ frame: DEFAULT_FRAME, fullscreen: false });
    expect(restoreFrame({ x: 5, y: 6, width: 700, height: 500 }, []).frame).toEqual({
      x: 5,
      y: 6,
      width: 700,
      height: 500,
    });
    expect(displayForFrame({ x: 1400, y: 100, width: 400, height: 300 }, [primary, external])?.id).toBe(2);
    expect(displayForFrame({ x: -5000, y: 0, width: 400, height: 300 }, [primary, external])).toBeNull();
  });
});
