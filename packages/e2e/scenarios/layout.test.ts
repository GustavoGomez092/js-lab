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

  test("the runtime selector switches the active tab between all three runtimes (EX-24)", async () => {
    // A selector test, not an execution test. Auto Run is off so that switching a runtime doesn't also start a
    // run (spec §5.2): a browser run would bundle the tab and spin up a webview, which says nothing about the
    // selector and would make this scenario depend on the whole web pipeline.
    //
    // This replaces an M2-era assertion that Bun was the only selectable runtime and that `runtime.browserNode`
    // was refused as a disabled command. Task 9 widened `AVAILABLE_RUNTIMES` to all three, which made that
    // assertion false by design; it was left failing rather than quietly rewritten, because it was a behavioural
    // claim belonging to another task.
    const app = await launchApp({ settings: { version: 3, run: { autoRun: false } } });
    apps.push(app);

    /** Runs a runtime command and waits for the tab to actually report that runtime. */
    const select = async (command: string, runtime: string) => {
      await app.command(command);
      return waitFor(async () => (activeTab(await app.state()).runtime === runtime ? runtime : null), {
        message: `the tab never switched to ${runtime}`,
      });
    };

    // Each command is accepted (none is refused as disabled) and each one moves the tab to that runtime. The two
    // browser runtimes are real transitions away from the `bun` default, so this cannot pass by standing still.
    expect(await select("runtime.bun", "bun")).toBe("bun");
    expect(await select("runtime.browserNode", "browser-node")).toBe("browser-node");
    expect(await select("runtime.browser", "browser")).toBe("browser");
  });
});
