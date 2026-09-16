import { afterEach, expect, test } from "bun:test";
import { activeTab, createUserData, type LaunchedApp, launchApp, waitFor } from "../src";

let apps: LaunchedApp[] = [];
afterEach(async () => {
  for (const app of apps.reverse()) await app.dispose();
  apps = [];
});

test("an edit typed right before quitting is saved (X1, X5)", async () => {
  const userData = await createUserData();
  const app = await launchApp({ userData, settings: { version: 3, run: { autoRun: false } } });
  apps.push(app);
  await app.type("const quick = 42");
  await waitFor(async () => activeTab(await app.state()).code === "const quick = 42" || null);
  await app.quit();
  const again = await launchApp({ userData });
  apps.push(again);
  expect(activeTab(await again.state()).code).toBe("const quick = 42");
});
