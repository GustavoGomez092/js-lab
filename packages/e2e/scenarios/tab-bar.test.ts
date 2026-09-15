import { afterEach, describe, expect, test } from "bun:test";
import { activeTab, type LaunchedApp, launchApp, waitFor } from "../src";

let app: LaunchedApp | null = null;
afterEach(async () => {
  await app?.dispose();
  app = null;
});

const tabCount = async (target: LaunchedApp, count: number) =>
  waitFor(async () => {
    const state = await target.state();
    return state.ui.tabOrder.length === count ? state : null;
  });

describe("tab bar", () => {
  test("titles come from the first line, and the bar hides for a single tab when configured (TF-02, TF-07)", async () => {
    app = await launchApp({ settings: { version: 2, view: { tabBarForSingleTab: false } } });
    expect(((await app.state()).ui.regions as Record<string, boolean>).tabBar).toBe(false);
    await app.type("const answer = 42");
    await waitFor(async () => activeTab(await (app as LaunchedApp).state()).title === "const answer = 42" || null);
    await app.newTab();
    const state = await tabCount(app, 2);
    expect((state.ui.regions as Record<string, boolean>).tabBar).toBe(true);
    await app.screenshot("tab-bar-two-tabs");
  });

  test("Close to the Right and Close Others (TF-04)", async () => {
    app = await launchApp();
    for (let i = 0; i < 3; i++) await app.newTab();
    await tabCount(app, 4);
    await app.command("tab.goto2");
    await app.command("tab.closeToRight");
    await tabCount(app, 2);
    await app.command("tab.closeOthers");
    const state = await tabCount(app, 1);
    expect(state.ui.closedCount).toBe(3);
  });

  test("Rename opens a dialog and Escape cancels it (TF-02)", async () => {
    app = await launchApp();
    await app.command("tab.rename");
    await waitFor(async () => (await (app as LaunchedApp).state()).ui.modal === "rename" || null);
    await app.screenshot("tab-rename-dialog");
    await app.key("escape");
    await waitFor(async () => (await (app as LaunchedApp).state()).ui.modal === null || null);
    expect(activeTab(await app.state()).titleIsCustom).toBe(false);
  });
});
