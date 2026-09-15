import { afterEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { activeTab, type LaunchedApp, launchApp, waitFor } from "../src";

// biome-ignore lint/suspicious/noExplicitAny: persisted JSON is read field by field
const readJson = async (path: string): Promise<Record<string, any>> => JSON.parse(await readFile(path, "utf8"));

let apps: LaunchedApp[] = [];
afterEach(async () => {
  for (const app of apps.reverse()) await app.dispose();
  apps = [];
});

type Regions = Record<string, boolean>;
const regions = async (app: LaunchedApp) => (await app.state()).ui.regions as Regions;

describe("layout", () => {
  test("toolbar, activity bar and status bar render; toggles hide them and persist (TF-16..TF-19, ST-07)", async () => {
    const app = await launchApp();
    apps.push(app);
    expect(await regions(app)).toMatchObject({
      toolbar: true,
      activityBar: true,
      statusBar: true,
      output: true,
      sideBar: false,
    });
    await app.screenshot("layout-default");
    await app.command("view.toggleStatusBar");
    await app.command("view.toggleActivityBar");
    await app.command("view.toggleOutput");
    await app.command("view.toggleLayout");
    await app.command("view.toggleSideBar");
    const toggled = await waitFor(async () => {
      const r = await regions(app);
      return !r.statusBar && !r.activityBar && !r.output && r.sideBar ? r : null;
    });
    expect(toggled.toolbar).toBe(true);
    expect(activeTab(await app.state()).layout).toMatchObject({ orientation: "vertical", outputVisible: false });
    await app.screenshot("layout-toggled");
    // FA-m10: wait until the toggles are on disk (settings.json for the regions, session.json for the tab layout)
    // instead of sleeping past the UI's 500 ms debounce.
    await waitFor(
      async () => {
        const view = (await readJson(join(app.userData, "settings.json"))).view;
        const session = await readJson(join(app.userData, "session.json"));
        const layout = session.tabs?.[session.activeTabId]?.layout;
        return (
          (view?.statusBar === false &&
            view?.activityBar === false &&
            view?.sideBar === true &&
            layout?.orientation === "vertical" &&
            layout?.outputVisible === false) ||
          null
        );
      },
      { timeoutMs: 10_000, message: "the layout toggles were never persisted" },
    );
    await app.quit();

    const again = await launchApp({ userData: app.userData });
    apps.push(again);
    expect(await regions(again)).toMatchObject({ statusBar: false, activityBar: false, output: false, sideBar: true });
    expect(activeTab(await again.state()).layout.orientation).toBe("vertical");
  });

  test("the runtime selector keeps Bun and rejects runtimes that arrive later (EX-24)", async () => {
    const app = await launchApp();
    apps.push(app);
    await app.command("runtime.bun");
    expect(activeTab(await app.state()).runtime).toBe("bun");
    await expect(app.command("runtime.browserNode")).rejects.toThrow("Command is disabled: runtime.browserNode");
  });
});
