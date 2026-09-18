import { afterEach, describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { activeTab, type LaunchedApp, launchApp, waitFor } from "../src";

/**
 * The Console/Web View preview pane must have real height.
 *
 * **Why this scenario exists at all, rather than a unit test.** happy-dom has no layout engine: every box it
 * reports is zero, and `apps/ui`'s tests never load `styles.css` in the first place. A defect whose entire
 * mechanism is CSS box sizing is therefore invisible to every unit test in this repo -- asserting heights against
 * happy-dom would be false coverage, not coverage. Only a real run of the built app lays anything out.
 *
 * **The defect being pinned.** `OutputTiles` renders a `SplitPane` inside the outer Editor/Output `SplitPane`'s
 * pane, so a `.split` becomes the child of a `.split-pane`. While `.split-pane` was a block container, `.split`'s
 * `flex: 1` was inert -- it is an assertion about the PARENT -- so the nested split took its content height
 * instead of the pane's. Measured on the built app at two window sizes before the fix: `.output` was 1352x52 and
 * 1652x52, the toolbar alone, because its `flex-basis: 55%` resolved against an indefinite height; and the Web
 * View pane's `flex: 1` had no free space, so the dock measured zero-height and `WebViewTile`'s degenerate-rect
 * guard collapsed the tile to 1x1 at the origin. Both readings are asserted against below, so a regression
 * reproduces as a failure here rather than as a stranded native surface a user has to report.
 *
 * The assertions are deliberately relative (the pane is far taller than its toolbar; the tile is not the 1x1
 * collapsed box; the tile sits below the console; both grow when the window does) rather than pinned to exact
 * pixel counts, which would break on any unrelated chrome change without catching anything extra.
 */

type Rect = { x: number; y: number; width: number; height: number };
type Diagnostics = {
  rects: Record<string, Rect | null>;
  webviewCount: number;
  viewport: { width: number; height: number };
};

/** The console pane's toolbar, the height `.output` collapsed to when the nested split had no definite height. */
const TOOLBAR_ONLY_HEIGHT = 52;

let apps: LaunchedApp[] = [];
afterEach(async () => {
  for (const app of apps.reverse()) await app.dispose();
  apps = [];
});

const diagnostics = async (t: LaunchedApp): Promise<Diagnostics> =>
  (await t.state()).ui.overlayDiagnostics as Diagnostics;
const regions = async (t: LaunchedApp) => (await t.state()).ui.regions as Record<string, boolean>;
// biome-ignore lint/suspicious/noExplicitAny: persisted JSON is read field by field
const readJson = async (p: string): Promise<Record<string, any>> => JSON.parse(await readFile(p, "utf8"));

/** Leaves the session as a returning user's would be: Web View on, shown as the bottom preview pane. */
async function showPreviewFor(userData: string, tabId: string, frame: Rect) {
  const path = join(userData, "session.json");
  const session = await readJson(path);
  const layout = session.tabs[tabId].layout;
  layout.tiles = { ...layout.tiles, webviewVisible: true, consoleSize: 55 };
  layout.orientation = "vertical";
  layout.outputVisible = true;
  layout.editorSize = 45;
  session.window = { ...frame, fullscreen: false };
  await writeFile(path, JSON.stringify(session));
}

async function measure(userData: string, label: string) {
  const app = await launchApp({ userData });
  apps.push(app);
  await waitFor(async () => ((await regions(app)).webViewTile === true ? true : null), {
    timeoutMs: 20_000,
    message: `the Web View tile never appeared (${label})`,
  });
  const d = await diagnostics(app);
  const tile = d.rects.webViewTile as Rect | null;
  const output = d.rects.output as Rect | null;
  console.log(`${label}: viewport=${d.viewport.width}x${d.viewport.height}`);
  console.log(`  output ${output ? `${output.width}x${output.height} @ y=${output.y}` : "ABSENT"}`);
  console.log(`  tile   ${tile ? `${tile.width}x${tile.height} @ y=${tile.y}` : "ABSENT"}`);
  await app.quit();
  return { tile, output, viewport: d.viewport };
}

describe("Web View preview pane height", () => {
  test("the preview pane and the console both get real height, at two window sizes", async () => {
    const first = await launchApp({ settings: { version: 3, run: { autoRun: false } } });
    apps.push(first);
    await first.command("runtime.browser");
    await waitFor(async () => (activeTab(await first.state()).runtime === "browser" ? true : null), {
      message: "the tab never switched to browser",
    });
    const tabId = activeTab(await first.state()).id;
    await first.quit();

    const frameA = { x: 100, y: 60, width: 1400, height: 1000 };
    await showPreviewFor(first.userData, tabId, frameA);
    const a = await measure(first.userData, "SIZE A - 1400x1000");

    const frameB = { x: 100, y: 60, width: 1700, height: 1200 };
    await showPreviewFor(first.userData, tabId, frameB);
    const b = await measure(first.userData, "SIZE B - 1700x1200");

    for (const [label, m] of [
      ["A", a],
      ["B", b],
    ] as const) {
      const { tile, output } = m;
      expect(tile, `${label}: the docked tile must exist`).toBeTruthy();
      expect(output, `${label}: the console pane must exist`).toBeTruthy();
      const t = tile as Rect;
      const o = output as Rect;

      // The console kept only its toolbar (52px) when the nested split had no definite height.
      expect(o.height, `${label}: console is toolbar-only`).toBeGreaterThan(TOOLBAR_ONLY_HEIGHT * 2);
      // The tile collapsed to COLLAPSED_STYLE's 1x1 at the origin once the dock measured zero-height.
      expect(t.width, `${label}: tile width is degenerate/collapsed`).toBeGreaterThan(1);
      expect(t.height, `${label}: tile height is degenerate/collapsed`).toBeGreaterThan(1);
      // ...which also placed it at 0,0, on top of the editor, instead of below the console.
      expect(t.y, `${label}: tile must sit below the console pane`).toBeGreaterThanOrEqual(o.y + o.height);
    }

    // A taller window must give both panes more room -- the collapsed state was identical at both sizes, which is
    // precisely how the defect showed itself as "the surface does not follow the window".
    expect(b.viewport.height).toBeGreaterThan(a.viewport.height);
    expect((b.output as Rect).height).toBeGreaterThan((a.output as Rect).height);
    expect((b.tile as Rect).height).toBeGreaterThan((a.tile as Rect).height);
  }, 240_000);
});
