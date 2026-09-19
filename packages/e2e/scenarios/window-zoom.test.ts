import { afterEach, describe, expect, test } from "bun:test";
import { type LaunchedApp, launchApp, waitFor } from "../src";

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

let apps: LaunchedApp[] = [];
afterEach(async () => {
  for (const app of apps.reverse()) await app.dispose();
  apps = [];
});

async function geometry(app: LaunchedApp): Promise<{ frame: Rect; workArea: Rect }> {
  const { main } = await app.state();
  return { frame: main.windowFrame as Rect, workArea: main.primaryWorkArea as Rect };
}

const near = (a: number, b: number, tolerance = 2) => Math.abs(a - b) <= tolerance;
const sameRect = (a: Rect, b: Rect) =>
  near(a.x, b.x) && near(a.y, b.y) && near(a.width, b.width) && near(a.height, b.height);

/** Waits until the window frame is no longer `from`, so the assertions never read a frame mid-animation. */
async function frameAfter(app: LaunchedApp, from: Rect, what: string): Promise<Rect> {
  return waitFor(
    async () => {
      const { frame } = await geometry(app);
      return sameRect(frame, from) ? null : frame;
    },
    { timeoutMs: 10_000, message: `The window frame never changed after ${what}` },
  );
}

describe("window zoom (double-click the title bar)", () => {
  /**
   * macOS zoom is not a Windows-style maximize: it fills the display's *visible* frame, leaving the menu bar and
   * the Dock on screen, and a second zoom returns the window to the frame it had before. A raw fill that covered
   * the Dock, or one that would not restore, would be worse than not having the feature -- so this measures the
   * resulting frame against the work area rather than merely checking that something moved.
   */
  test("zoom fills the work area without covering the menu bar or Dock, and zooming again restores the frame", async () => {
    const app = await launchApp();
    apps.push(app);
    const { frame: before, workArea } = await geometry(app);
    // The window must start un-zoomed, or "it grew" would prove nothing.
    expect(sameRect(before, workArea)).toBe(false);

    await app.command("view.zoomWindow");
    const zoomed = await frameAfter(app, before, "view.zoomWindow");

    // Inside the work area: the menu bar strip above it and the Dock strip below it stay uncovered.
    expect(zoomed.x).toBeGreaterThanOrEqual(workArea.x - 2);
    expect(zoomed.y).toBeGreaterThanOrEqual(workArea.y - 2);
    expect(zoomed.x + zoomed.width).toBeLessThanOrEqual(workArea.x + workArea.width + 2);
    expect(zoomed.y + zoomed.height).toBeLessThanOrEqual(workArea.y + workArea.height + 2);
    // And filling it, rather than merely growing a little.
    expect(zoomed.width).toBeGreaterThanOrEqual(workArea.width - 2);
    expect(zoomed.height).toBeGreaterThanOrEqual(workArea.height - 2);

    await app.command("view.zoomWindow");
    const restored = await frameAfter(app, zoomed, "the second view.zoomWindow");
    expect(restored).toEqual(before);
  });
});
