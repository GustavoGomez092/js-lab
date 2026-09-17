import { afterEach, describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { activeTab, type LaunchedApp, launchApp, waitFor } from "../src";

/**
 * The Web View tile (spec §7.1, parity WV-01, TF-19): it exists only for a runtime that can host a webview, it is
 * per tab, and it survives a relaunch.
 *
 * **Why these scenarios drive the toggle the way they do.** Task 9g gave the toggle a command id
 * (`view.toggleWebView`, with a View menu item and ⌥⌘W), so it can be driven directly now. These scenarios still
 * set the tab's own `layout.tiles.webviewVisible` the way a returning user's session sets it (through
 * `session.json`) and then make the tile appear and disappear through the runtime switcher, because that -- not
 * the toggle itself -- is the rule under test: a `bun` tab never gets a tile, whatever its stored toggle says.
 */

let apps: LaunchedApp[] = [];
afterEach(async () => {
  for (const app of apps.reverse()) await app.dispose();
  apps = [];
});

type Regions = Record<string, boolean>;
const regions = async (app: LaunchedApp) => (await app.state()).ui.regions as Regions;

// biome-ignore lint/suspicious/noExplicitAny: persisted JSON is read field by field
const readJson = async (path: string): Promise<Record<string, any>> => JSON.parse(await readFile(path, "utf8"));

/** The active tab's tile settings. `TabSnapshot.layout` is deliberately open-ended in the harness, so name the shape. */
const tilesOf = async (app: LaunchedApp) =>
  activeTab(await app.state()).layout.tiles as { webviewVisible: boolean; consoleSize: number };

async function useRuntime(target: LaunchedApp, command: string, runtime: string) {
  await target.command(command);
  await waitFor(async () => activeTab(await target.state()).runtime === runtime || null, {
    message: `the tab never switched to ${runtime}`,
  });
}

/** Turns the stored Web View toggle on for the given tabs, as a previous session would have left it. */
async function showWebViewFor(userData: string, tabIds: string[]) {
  const path = join(userData, "session.json");
  const session = await readJson(path);
  for (const id of tabIds) {
    const layout = session.tabs[id].layout;
    layout.tiles = { ...layout.tiles, webviewVisible: true, consoleSize: 40 };
  }
  await writeFile(path, JSON.stringify(session));
}

const tileShown = async (app: LaunchedApp, shown: boolean) =>
  waitFor(async () => (await regions(app)).webViewTile === shown || null, {
    timeoutMs: 20_000,
    message: `the Web View tile was never ${shown ? "shown" : "hidden"}`,
  });

describe("the Web View tile (spec §7.1)", () => {
  test("the tile renders for a browser tab, never for a bun tab, and comes back when the runtime does (WV-01, TF-19)", async () => {
    const first = await launchApp({ settings: { version: 3, run: { autoRun: false } } });
    apps.push(first);
    await useRuntime(first, "runtime.browser", "browser");
    // A tab's Web View starts hidden, so a browser tab alone is not enough to put a tile on screen.
    expect((await regions(first)).webViewTile).toBe(false);
    const tabId = activeTab(await first.state()).id;
    await first.quit();

    await showWebViewFor(first.userData, [tabId]);
    const app = await launchApp({ userData: first.userData });
    apps.push(app);
    // The stored toggle and split came back, and the tile is really on screen.
    expect(activeTab(await app.state()).layout.tiles).toMatchObject({ webviewVisible: true, consoleSize: 40 });
    await tileShown(app, true);
    await app.screenshot("web-view-tile-shown");

    // Switching to Bun takes the tile away even though the tab's own toggle is still on -- a `bun` tab never has a
    // Web View tile, and the stored preference is kept for when the tab goes back.
    await useRuntime(app, "runtime.bun", "bun");
    await tileShown(app, false);
    expect((await tilesOf(app)).webviewVisible).toBe(true);
    await app.screenshot("web-view-tile-bun");

    // Browser & Node APIs hosts a webview too, so the tile returns.
    await useRuntime(app, "runtime.browserNode", "browser-node");
    await tileShown(app, true);
  });

  test("the tile is per tab, and each tab's setting persists across a relaunch (WV-01, §10.1)", async () => {
    const first = await launchApp({ settings: { version: 3, run: { autoRun: false } } });
    apps.push(first);
    await useRuntime(first, "runtime.browser", "browser");
    const withTile = activeTab(await first.state()).id;
    const withoutTile = await first.newTab();
    await useRuntime(first, "runtime.browser", "browser");
    await first.quit();

    // Only the first tab's Web View is on.
    await showWebViewFor(first.userData, [withTile]);
    const app = await launchApp({ userData: first.userData });
    apps.push(app);

    // Whichever tab the session restored as active, step to the one whose Web View is off.
    for (let step = 0; step < 4 && (await app.state()).ui.activeTabId !== withoutTile; step += 1) {
      await app.command("tab.next");
    }
    expect((await app.state()).ui.activeTabId).toBe(withoutTile);
    // Both tabs are browser tabs; only the one whose toggle is on shows a tile.
    expect((await tilesOf(app)).webviewVisible).toBe(false);
    await tileShown(app, false);

    await app.command("tab.previous");
    await waitFor(async () => (await app.state()).ui.activeTabId === withTile || null, {
      message: "never returned to the tab whose Web View is on",
    });
    await tileShown(app, true);

    // The per-tab split survives another round trip to disk.
    await app.quit();
    const session = await readJson(join(app.userData, "session.json"));
    expect(session.tabs[withTile].layout.tiles).toMatchObject({ webviewVisible: true, consoleSize: 40 });
    expect(session.tabs[withoutTile].layout.tiles.webviewVisible).toBe(false);
  });
});
