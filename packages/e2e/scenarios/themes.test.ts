import { afterEach, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type LaunchedApp, launchApp, waitFor } from "../src";

let app: LaunchedApp | null = null;
afterEach(async () => {
  await app?.dispose();
  app = null;
});

test("Graphite is the default, and selecting a theme persists it and re-themes the window (ST-03, ST-04)", async () => {
  app = await launchApp();
  expect((await app.state()).ui.themeId).toBe("graphite");
  await app.screenshot("theme-graphite");
  await app.command("theme.select", { themeId: "dracula" });
  await waitFor(async () => (await app?.state())?.ui.themeId === "dracula" || null);
  await app.screenshot("theme-dracula");
  const saved = JSON.parse(await readFile(join(app.userData, "settings.json"), "utf8"));
  expect(saved.appearance).toMatchObject({ theme: "dracula", followSystem: false });
});

test("an unknown theme id in settings falls back to Graphite", async () => {
  app = await launchApp({ settings: { version: 2, appearance: { theme: "no-such-theme" } } });
  expect((await app.state()).ui.themeId).toBe("graphite");
});
