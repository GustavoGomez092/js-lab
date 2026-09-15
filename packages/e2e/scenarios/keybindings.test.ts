import { afterEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { activeTab, createUserData, type LaunchedApp, launchApp, waitFor } from "../src";

let apps: LaunchedApp[] = [];
afterEach(async () => {
  for (const app of apps.reverse()) await app.dispose();
  apps = [];
});

describe("keybindings", () => {
  test("every mapped Monaco action exists, and default shortcuts dispatch commands (TF-06, ED-21)", async () => {
    const app = await launchApp();
    apps.push(app);
    expect((await app.state()).ui.missingEditorActions).toEqual([]);
    await app.type("1 + 1");
    await app.waitForOutput((all) => all.length === 1);
    await app.key("cmd+t");
    // Wait until the new tab exists and is active before the next shortcut (review I4).
    await waitFor(async () => {
      const state = await app.state();
      return state.ui.tabOrder.length === 2 && state.ui.activeTabId === state.ui.tabOrder[1] ? state : null;
    });
    await app.key("cmd+1");
    const first = await waitFor(async () => {
      const state = await app.state();
      return state.ui.activeTabId === state.ui.tabOrder[0] ? state : null;
    });
    expect(activeTab(first).code).toBe("1 + 1");
    await app.key("cmd+k");
    await waitFor(async () => activeTab(await app.state()).entryCount === 0 || null);
  });

  test("Toggle Magic Comment adds //? to the current line (EX-13)", async () => {
    const app = await launchApp();
    apps.push(app);
    await app.type("[1, 2].length");
    await app.key("cmd+alt+shift+/");
    const state = await waitFor(async () => {
      const s = await app.state();
      return activeTab(s).code === "[1, 2].length //?" ? s : null;
    });
    expect(activeTab(state).code).toBe("[1, 2].length //?");
    await app.key("cmd+alt+shift+/");
    await waitFor(async () => activeTab(await app.state()).code === "[1, 2].length" || null);
  });

  test("keybindings.json overrides replace defaults (XT-02)", async () => {
    const userData = await createUserData();
    await writeFile(
      join(userData, "keybindings.json"),
      JSON.stringify([
        { key: "cmd+k", command: "-output.clear" },
        { key: "cmd+shift+k", command: "output.clear" },
      ]),
    );
    const app = await launchApp({ userData });
    apps.push(app);
    await app.type("40 + 2");
    await app.waitForOutput((all) => all.length === 1);
    await app.key("cmd+k");
    // FA-m10 sentinel: ⌘= goes through the same key dispatch right after ⌘K and has its own visible effect (zoom,
    // answered by Main). Once it has applied, ⌘K has been handled too, so the unchanged count is a real negative check.
    await app.key("cmd+=");
    await waitFor(async () => ((await app.state()).ui.settings?.appearance?.uiScale ?? 1) > 1 || null, {
      message: "the ⌘= sentinel never applied",
    });
    expect(activeTab(await app.state()).entryCount).toBe(1);
    await app.key("cmd+shift+k");
    await waitFor(async () => activeTab(await app.state()).entryCount === 0 || null);
  });
});
