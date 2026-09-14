import { afterEach, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type LaunchedApp, launchApp } from "../src";

let app: LaunchedApp | null = null;
afterEach(async () => {
  await app?.dispose();
  app = null;
});

test("an M1 settings file is migrated to v2 on launch and keeps its values (EX-23, LB-02)", async () => {
  app = await launchApp({ settings: { version: 1, run: { autoRunDelayMs: 50, defaultLanguage: "javascript" } } });
  const { ui } = await app.state();
  expect(ui.settings?.version).toBe(2);
  expect(ui.settings?.run).toMatchObject({ autoRunDelayMs: 50, defaultLanguage: "javascript", formatOnRun: false });
  expect(JSON.parse(await readFile(join(app.userData, "settings.json"), "utf8")).version).toBe(2);
});
