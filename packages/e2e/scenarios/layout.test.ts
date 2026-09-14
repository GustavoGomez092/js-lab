import { afterEach, describe, expect, test } from "bun:test";
import { activeTab, type LaunchedApp, launchApp, waitFor } from "../src";

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
    await Bun.sleep(700);
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
