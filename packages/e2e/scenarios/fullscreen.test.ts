import { afterEach, describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createUserData, type LaunchedApp, launchApp, waitFor } from "../src";

/**
 * TF-17's last toggle: View ▸ Full Screen, driven end to end (spec §7.4).
 *
 * The other four View toggles are covered by `layout.test.ts` and `menu.test.ts`, which read them back out of
 * `ui.regions` -- a region either mounted or not. Full Screen has no region: it changes the *window*, so the only
 * honest readings are the native frame and the space the UI ends up with. Both already exist as seams and are
 * already used this way by `window-zoom.test.ts` (`main.windowFrame`, `main.primaryWorkArea`) and by
 * `layout-under-translation.test.ts` (`ui.layoutMetrics.viewport`); nothing new is added here.
 *
 * **Why the frame is measured STRICTLY past the work area.** macOS zoom also grows the window, and
 * `view.zoomWindow` is a sibling command on the same menu -- so "bigger than before" would pass if Full Screen
 * were wired to zoom by mistake. These bounds were `>=`/`<=` until a mutation swapped the command for
 * `view.zoomWindow` and the test still passed them: zoom fills the work area *exactly*, satisfying any
 * non-strict bound with equality (measured: zoom 1920x1050 @ (0,30) against a work area of 1920x1050 @ (0,30)).
 * Full screen takes the whole display -- 1920x1080 @ (0,0) on the same machine -- so only `>` and `<` separate
 * the two commands.
 *
 * **Why the persisted flag is asserted too.** `frameToSave` (FA-m6) records `fullscreen: true` while keeping the
 * windowed frame, and that record is the entire input to the restore path. The second test writes exactly such a
 * session and relaunches, which is the established way this suite reaches window state it cannot drive directly
 * (`webview-preview-height.test.ts`). `apps/desktop/test/windows/frame-restore.test.ts` covers the same decision
 * as a pure function; this covers the real window obeying it.
 */

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

// biome-ignore lint/suspicious/noExplicitAny: persisted JSON is read field by field
const readJson = async (path: string): Promise<Record<string, any>> => JSON.parse(await readFile(path, "utf8"));

/** The windowed frame every launch below starts from: comfortably smaller than any display's work area. */
const WINDOWED: Rect = { x: 120, y: 80, width: 900, height: 700 };

/** Seeds a session file before the first launch, as `files.test.ts` does for the off-screen clamp. */
async function seedSession(userData: string, fullscreen: boolean) {
  await writeFile(join(userData, "session.json"), JSON.stringify({ version: 1, window: { ...WINDOWED, fullscreen } }));
}

async function geometry(app: LaunchedApp): Promise<{ frame: Rect; workArea: Rect }> {
  const { main } = await app.state();
  return { frame: main.windowFrame as Rect, workArea: main.primaryWorkArea as Rect };
}

const viewportOf = async (app: LaunchedApp): Promise<{ width: number; height: number }> =>
  ((await app.state()).ui.layoutMetrics as { viewport: { width: number; height: number } }).viewport;

const rect = (r: Rect) => `${r.width}x${r.height} @ (${r.x},${r.y})`;

const near = (a: number, b: number, tolerance = 2) => Math.abs(a - b) <= tolerance;
const sameRect = (a: Rect, b: Rect) =>
  near(a.x, b.x) && near(a.y, b.y) && near(a.width, b.width) && near(a.height, b.height);

/** Waits until the window frame is no longer `from`, so nothing is read mid-animation. */
async function frameAfter(app: LaunchedApp, from: Rect, what: string): Promise<Rect> {
  return waitFor(
    async () => {
      const { frame } = await geometry(app);
      return sameRect(frame, from) ? null : frame;
    },
    { timeoutMs: 20_000, message: `The window frame never changed after ${what}` },
  );
}

/** Waits for the persisted full-screen flag, which `saveFrame` writes through a debounced writer. */
async function persistedFullscreen(app: LaunchedApp, expected: boolean) {
  await waitFor(
    async () => (await readJson(join(app.userData, "session.json"))).window?.fullscreen === expected || null,
    { timeoutMs: 20_000, message: `session.json never recorded fullscreen: ${expected}` },
  );
}

describe("Full Screen (View menu, TF-17)", () => {
  test("Full Screen takes the whole display, records itself, and toggling again restores the windowed frame", async () => {
    const userData = await createUserData();
    await seedSession(userData, false);
    const app = await launchApp({ userData });
    apps.push(app);

    const { frame: before, workArea } = await geometry(app);
    // The window must start windowed, or "it grew" would prove nothing.
    expect(sameRect(before, WINDOWED)).toBe(true);
    expect(before.height).toBeLessThan(workArea.height);
    const viewportBefore = await viewportOf(app);

    await app.command("view.toggleFullScreen");
    const full = await frameAfter(app, before, "view.toggleFullScreen");

    console.log(`windowed ${rect(before)}`);
    console.log(`full     ${rect(full)}`);
    console.log(`workArea ${rect(workArea)}`);

    // Bigger than the windowed frame...
    expect(full.height).toBeGreaterThan(before.height);
    expect(full.width).toBeGreaterThan(before.width);
    // ...and STRICTLY past the work area, which is what separates full screen from zoom (see the header).
    expect(full.height).toBeGreaterThan(workArea.height);
    expect(full.y).toBeLessThan(workArea.y);
    // The zoom frame *is* the work area; the full-screen frame never is.
    expect(sameRect(full, workArea)).toBe(false);

    // The UI actually received the space -- a native frame that grew while the view kept its old box would be the
    // defect this catches (it is exactly how the Web View tile failed in `webview-preview-height.test.ts`).
    // The wait itself is the assertion: it fails the test if the viewport never grows. An `expect` restating the
    // same comparison afterwards could not fail, so there isn't one.
    await waitFor(
      async () => {
        const viewport = await viewportOf(app);
        return viewport.height > viewportBefore.height ? viewport : null;
      },
      { timeoutMs: 20_000, message: "the UI viewport never grew after entering full screen" },
    );

    // FA-m6: the windowed frame is kept, flagged full screen -- which is what the restore test below consumes.
    await persistedFullscreen(app, true);
    expect((await readJson(join(app.userData, "session.json"))).window).toMatchObject({
      width: WINDOWED.width,
      height: WINDOWED.height,
    });

    await app.command("view.toggleFullScreen");
    const restored = await frameAfter(app, full, "the second view.toggleFullScreen");
    expect(sameRect(restored, before)).toBe(true);
    await persistedFullscreen(app, false);
  }, 240_000);

  test("a session saved full screen reopens full screen", async () => {
    const userData = await createUserData();
    await seedSession(userData, true);
    const app = await launchApp({ userData });
    apps.push(app);

    // `createWindow` applies `setFullScreen(true)` at construction; the transition is animated, so this waits for
    // the frame rather than reading it once.
    const { workArea } = await geometry(app);
    const frame = await waitFor(
      async () => {
        const { frame: current } = await geometry(app);
        return current.height > WINDOWED.height ? current : null;
      },
      { timeoutMs: 30_000, message: "the restored window never entered full screen" },
    );
    console.log(`restored full ${rect(frame)}`);
    console.log(`workArea      ${rect(workArea)}`);
    // Strict, for the reason in the header: a non-strict bound is also satisfied by a merely zoomed window, which
    // would let "it reopened full screen" pass on a window that only filled the work area.
    expect(frame.height).toBeGreaterThan(workArea.height);
    expect(frame.y).toBeLessThan(workArea.y);
    expect(sameRect(frame, workArea)).toBe(false);
  }, 240_000);
});
