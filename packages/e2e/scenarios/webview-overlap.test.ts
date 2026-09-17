import { afterEach, describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { activeTab, type LaunchedApp, launchApp, waitFor } from "../src";

/**
 * M4 diagnostics for the user report "console output rows are invisible behind the Web View".
 *
 * A prior investigation established that this is a **paint** defect, not a data defect: the filter chips count
 * entries the rows never show, and nothing on the path from the console hook to `EntryRow` branches on level. A
 * native `<electrobun-webview>` surface paints above all HTML regardless of `z-index`, so CSS cannot arbitrate it.
 *
 * What was still unnamed is *why* the surface covers console rows it does not overlap in HTML -- the console tile
 * and the Web View tile are sibling `SplitPane` panes with disjoint boxes. This scenario measures, in the live UI:
 *
 *   1. `.webview-tile[aria-hidden="false"]` -- where JSLab thinks the tile is.
 *   2. `electrobun-webview` -- the exact element `OverlaySyncController.sync()` measures and ships as the native
 *      frame (`apps/desktop/.hutch/devkit/api/preload/overlaySync.ts`).
 *   3. `.output` -- the console pane.
 *
 * If (2) does NOT overlap (3), the frame JS requests is correct and the defect is below the JS boundary (native
 * placement/scale/inset). If it DOES, the defect is in JSLab's own rect plumbing and belongs in `WebViewTile`.
 *
 * **Why the tiles are set through `session.json` rather than the `view.toggleWebView` command.** Driving the
 * toggle alone produced a tile with a real width but a height of exactly 0, which is not the condition the user
 * reports (a *visible* Web View covering console rows) and makes the overlap question meaningless. Setting the
 * stored tiles the way a returning user's session would -- the same approach `web-view-tile.test.ts` uses -- is
 * what puts a genuinely on-screen, non-degenerate Web View next to the console. The 0-height reading is itself
 * reported below, because a 548x0 frame still passes `OverlaySyncController`'s `width === 0 && height === 0`
 * guard and is shipped to the native layer.
 *
 * It also samples `WebViewTile`'s re-measure/re-render counters across an idle window, for a second user report
 * ("not running the web view gets rid of the reload error"): a docked tile that keeps re-rendering while nothing
 * is running is a re-render driver independent of run state.
 *
 * This scenario deliberately asserts only that the measurement was actually taken -- the overlap verdict is
 * reported, not assumed, because the whole point is to learn which side of the decision it falls on.
 */

type Rect = { x: number; y: number; width: number; height: number };
type Diagnostics = {
  rects: Record<string, Rect | null>;
  webviewCount: number;
  viewport: { width: number; height: number };
  counters: {
    measures: number;
    renders: number;
    hosts: number;
    app: number;
    appInputs: Record<string, number>;
    runStateTrail: string[];
  };
};

let apps: LaunchedApp[] = [];
afterEach(async () => {
  for (const app of apps.reverse()) await app.dispose();
  apps = [];
});

const diagnostics = async (target: LaunchedApp): Promise<Diagnostics> =>
  (await target.state()).ui.overlayDiagnostics as Diagnostics;

const regions = async (target: LaunchedApp) => (await target.state()).ui.regions as Record<string, boolean>;

/**
 * The intersection of two rectangles, or `null` when they share no *area*.
 *
 * Deliberately requires a strictly positive width AND height. A degenerate rect (this app really does produce a
 * 548x0 one) would satisfy a naive `a.x < b.right && b.x < a.right && ...` test on strict inequalities alone and
 * report an "overlap" whose area is zero -- which would be a false verdict, not a finding.
 */
function intersection(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const width = Math.min(a.x + a.width, b.x + b.width) - x;
  const height = Math.min(a.y + a.height, b.y + b.height) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}

const show = (name: string, rect: Rect | null | undefined) =>
  rect
    ? `${name}: x=${rect.x} y=${rect.y} w=${rect.width} h=${rect.height} (right=${rect.x + rect.width}, bottom=${rect.y + rect.height})`
    : `${name}: ABSENT`;

// biome-ignore lint/suspicious/noExplicitAny: persisted JSON is read field by field
const readJson = async (path: string): Promise<Record<string, any>> => JSON.parse(await readFile(path, "utf8"));

/** Turns the stored Web View toggle on for a tab, as a previous session would have left it. */
async function showWebViewFor(userData: string, tabId: string) {
  const path = join(userData, "session.json");
  const session = await readJson(path);
  const layout = session.tabs[tabId].layout;
  layout.tiles = { ...layout.tiles, webviewVisible: true, arrangement: "side-by-side", consoleSize: 40 };
  await writeFile(path, JSON.stringify(session));
}

describe("Web View / console overlap (user report: console rows invisible)", () => {
  test("reports the tile, native-surface and console rects from the live UI", async () => {
    // A browser tab is the only kind that can host a webview at all (spec §7.1). Set it up, then store the tiles
    // and relaunch so the Web View comes back genuinely on screen rather than collapsed.
    const first = await launchApp({ settings: { version: 3, run: { autoRun: false } } });
    apps.push(first);
    await first.command("runtime.browser");
    await waitFor(async () => activeTab(await first.state()).runtime === "browser" || null, {
      message: "the tab never switched to browser",
    });
    const tabId = activeTab(await first.state()).id;
    await first.quit();

    await showWebViewFor(first.userData, tabId);
    const app = await launchApp({ userData: first.userData });
    apps.push(app);
    await waitFor(async () => (await regions(app)).webViewTile === true || null, {
      timeoutMs: 20_000,
      message: "the Web View tile never appeared",
    });

    // Put at least one console.log and one console.error on screen -- the exact pair the user says goes missing.
    const code = ['console.log("visible-log");', 'console.error("visible-error");'].join("\n");
    await app.type(code);
    await waitFor(async () => activeTab(await app.state()).code === code || null, {
      message: "the editor never took the typed code",
    });
    await app.command("run.start");
    await app.waitForOutput(
      (entries) =>
        entries.some((entry) => entry.text.includes("visible-log")) &&
        entries.some((entry) => entry.text.includes("visible-error")),
      90_000,
    );
    // The run must be over before the idle-window sample below, or "idle" would be a lie.
    await app.waitForRunState(["idle", "settled", "stopped"], 60_000);

    const first_ = await diagnostics(app);
    expect(first_).toBeTruthy();
    const { webViewTile, webviewSurfaceDocked, webviewSurfaceFirst, output } = first_.rects;

    console.log("\n===== WEBVIEW/CONSOLE RECTS =====");
    console.log(`viewport: ${first_.viewport.width}x${first_.viewport.height}`);
    console.log(`tiles: ${JSON.stringify(activeTab(await app.state()).layout.tiles)}`);
    console.log(show("1. .webview-tile[aria-hidden=false]", webViewTile));
    console.log(show("2. electrobun-webview (docked)    ", webviewSurfaceDocked));
    console.log(show("2b. electrobun-webview (first tag)", webviewSurfaceFirst));
    console.log(show("3. .output                        ", output));
    console.log(`electrobun-webview element count: ${first_.webviewCount}`);

    // The measurement has to have actually happened; a missing rect means the scenario proved nothing. `toBeTruthy`
    // rather than `not.toBeNull`, so an absent key (undefined) fails here too instead of sliding through.
    expect(output).toBeTruthy();
    expect(webViewTile).toBeTruthy();
    expect(webviewSurfaceDocked).toBeTruthy();

    const surface = webviewSurfaceDocked as Rect;
    const consolePane = output as Rect;
    const tile = webViewTile as Rect;
    const shared = intersection(surface, consolePane);

    console.log(`\nsurface area: ${surface.width * surface.height} (w=${surface.width}, h=${surface.height})`);
    console.log(`intersection with .output: ${shared ? JSON.stringify(shared) : "NONE (zero area)"}`);
    console.log(`\nVERDICT: electrobun-webview ${shared ? "OVERLAPS" : "does NOT overlap"} .output`);
    console.log(
      shared
        ? "  -> the defect is in JSLab's own rect plumbing (WebViewTile)."
        : "  -> the frame JS requests is correct; the defect is below the JS boundary (native placement/scale/inset).",
    );
    console.log(`tile vs surface agree: ${JSON.stringify(tile) === JSON.stringify(surface)}`);

    // Second user report: does a docked tile keep re-rendering while nothing is running? `measures` counts
    // `setRect` calls specifically, so the two numbers together say whether any churn is the tile's own
    // measure/ResizeObserver path or something upstream re-rendering it.
    const before = first_.counters;
    await Bun.sleep(3000);
    const after = (await diagnostics(app)).counters;
    console.log("\n===== IDLE-WINDOW COUNTERS (3s, nothing running) =====");
    console.log(
      `measures (setRect calls): ${before.measures} -> ${after.measures} (delta ${after.measures - before.measures})`,
    );
    console.log(
      `renders (tile):           ${before.renders} -> ${after.renders} (delta ${after.renders - before.renders})`,
    );
    // Round 2: where the loop STARTS. An in-process probe proved the tile's churn is just `App` re-rendering and
    // passing through `WebViewHosts` with `docked`/`dockNode` unchanged (which is why `measures` stays flat), so
    // these three lines are what name the driver: if `app` climbs in step with the tile, the shell is the loop, and
    // `appInputs` says which of its own subscriptions kept changing identity to drive it.
    console.log(`renders (WebViewHosts):   ${before.hosts} -> ${after.hosts} (delta ${after.hosts - before.hosts})`);
    console.log(`renders (App):            ${before.app} -> ${after.app} (delta ${after.app - before.app})`);
    const inputDeltas = Object.keys({ ...before.appInputs, ...after.appInputs })
      .map((key) => [key, (after.appInputs[key] ?? 0) - (before.appInputs[key] ?? 0)] as const)
      .filter(([, delta]) => delta > 0)
      .sort((a, b) => b[1] - a[1]);
    console.log(
      `App inputs that changed:  ${
        inputDeltas.length === 0 ? "NONE" : inputDeltas.map(([key, delta]) => `${key} +${delta}`).join(", ")
      }`,
    );
    // Round 3: every delta above is a change of VALUE (`runState` is a primitive), so these are the values
    // themselves -- an `idle->settled`/`settled->idle` pair would be the already-fixed self-rescheduling-handle
    // dip, and anything else is a defect those fixes do not cover.
    console.log(
      `runState transitions:     ${after.runStateTrail.length === 0 ? "NONE" : after.runStateTrail.join(" | ")}`,
    );
    console.log("======================================================\n");

    await app.screenshot("webview-overlap-rects");
  });
});
