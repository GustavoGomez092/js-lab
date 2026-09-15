import { afterEach, expect, test } from "bun:test";
import { type LaunchedApp, launchApp, waitFor } from "../src";

let app: LaunchedApp | null = null;
afterEach(async () => {
  await app?.dispose();
  app = null;
});

interface Item {
  label?: string;
  enabled?: boolean;
  submenu?: Item[];
}
const flatten = (items: Item[]): Item[] => items.flatMap((item) => [item, ...flatten(item.submenu ?? [])]);

test("⌘I opens NPM Packages, Tools opens Environment Variables, and the menus list the M3 items (TL-01, spec §7.4)", async () => {
  app = await launchApp();
  const current = app;
  await current.key("cmd+i");
  await waitFor(async () => (await current.state()).ui.modal === "npm" || null);
  await current.command("tools.environmentVariables");
  await waitFor(async () => (await current.state()).ui.modal === "env" || null);
  const menu = flatten((await current.state()).main.menu as Item[]);
  expect(menu.find((item) => item.label?.startsWith("NPM Packages…"))?.label).toBe("NPM Packages…    ⌘I");
  expect(menu.find((item) => item.label === "Set Working Directory…")?.enabled).toBe(true);
  expect(menu.find((item) => item.label === "Clear Working Directory")?.enabled).toBe(false);
});
