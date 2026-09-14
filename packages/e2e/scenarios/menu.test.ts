import { afterEach, describe, expect, test } from "bun:test";
import { type LaunchedApp, launchApp, waitFor } from "../src";

let app: LaunchedApp | null = null;
afterEach(async () => {
  await app?.dispose();
  app = null;
});

interface Item {
  label?: string;
  action?: string;
  checked?: boolean;
  enabled?: boolean;
  submenu?: Item[];
}

const flatten = (items: Item[]): Item[] => items.flatMap((item) => [item, ...flatten(item.submenu ?? [])]);
const menuOf = async (target: LaunchedApp) => flatten((await target.state()).main.menu as Item[]);
const find = (items: Item[], prefix: string) => items.find((item) => item.label?.startsWith(prefix));

describe("application menu", () => {
  test("the menu tracks theme, output visibility and the closed-tab stack (TF-17, ST-03)", async () => {
    app = await launchApp();
    const current = app;
    expect(find(await menuOf(current), "Graphite")?.checked).toBe(true);
    expect(find(await menuOf(current), "Run")?.label).toBe("Run    ⌘R");
    await current.command("theme.select", { themeId: "dracula" });
    await waitFor(async () => find(await menuOf(current), "Dracula")?.checked || null);
    await current.command("view.toggleOutput");
    await waitFor(async () => find(await menuOf(current), "Output")?.checked === false || null);
    expect(find(await menuOf(current), "Reopen Closed Tab")?.enabled).toBe(false);
    // Wait for the new tab to be active, or tab.close would close the only empty tab and the window (review I4).
    await current.newTab();
    await current.command("tab.close");
    await waitFor(async () => find(await menuOf(current), "Reopen Closed Tab")?.enabled || null);
  });

  test("every command the menu dispatches is registered in the UI", async () => {
    app = await launchApp();
    const state = await app.state();
    const registered = new Set(state.ui.registeredCommands as string[]);
    const menuCommands = flatten(state.main.menu as Item[])
      .flatMap((item) => (item.action?.startsWith("command:") ? [item.action.split(":")[1] as string] : []))
      // The Settings window arrives in Task 24, which removes this exclusion.
      .filter((id) => id !== "app.settings");
    expect(menuCommands.filter((id) => !registered.has(id))).toEqual([]);
  });
});
