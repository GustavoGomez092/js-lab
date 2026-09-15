import { afterEach, describe, expect, test } from "bun:test";
import { activeTab, type LaunchedApp, launchApp, waitFor } from "../src";

let apps: LaunchedApp[] = [];
afterEach(async () => {
  for (const app of apps.reverse()) await app.dispose();
  apps = [];
});

describe("tabs", () => {
  test("each tab keeps its own code and output, and tabs persist across relaunch (TF-01, TF-06, TF-13)", async () => {
    const app = await launchApp();
    apps.push(app);
    await app.type("1 + 1");
    await app.waitForOutput((all) => all.some((e) => e.text === "2"));
    await app.newTab();
    await app.type("'second'");
    await app.waitForOutput((all) => all.some((e) => e.text === "second"));
    await app.command("tab.previous");
    const first = await waitFor(async () => {
      const state = await app.state();
      return activeTab(state).code === "1 + 1" ? state : null;
    });
    expect((await app.output()).map((e) => e.text)).toEqual(["2"]);
    const order = first.ui.tabOrder;
    await app.quit();

    const again = await launchApp({ userData: app.userData });
    apps.push(again);
    const restored = await again.state();
    expect(restored.ui.tabOrder).toEqual(order);
    expect(restored.ui.tabs.map((tab) => tab.code)).toEqual(["1 + 1", "'second'"]);
    expect(restored.ui.tabs.every((tab) => tab.runState === null)).toBe(true);
  });

  test("a closed tab reopens with its content (TF-05)", async () => {
    const app = await launchApp();
    apps.push(app);
    await app.newTab();
    await app.type("const kept = 'yes'");
    await app.command("tab.close");
    await waitFor(async () => (await app.state()).ui.tabOrder.length === 1 || null);
    await app.command("tab.reopenClosed");
    const state = await waitFor(async () => {
      const s = await app.state();
      return s.ui.tabOrder.length === 2 ? s : null;
    });
    expect(activeTab(state).code).toBe("const kept = 'yes'");
  });
});
