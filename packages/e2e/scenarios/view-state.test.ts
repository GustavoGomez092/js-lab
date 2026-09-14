import { afterEach, expect, test } from "bun:test";
import { type LaunchedApp, launchApp, waitFor } from "../src";

let apps: LaunchedApp[] = [];
afterEach(async () => {
  for (const app of apps.reverse()) await app.dispose();
  apps = [];
});

const cursorLine = (app: LaunchedApp, line: number) =>
  waitFor(async () => {
    const state = await app.state();
    return state.ui.cursor?.line === line ? state : null;
  });

test("each tab restores its own cursor when switching tabs and after relaunch (TF-13)", async () => {
  const app = await launchApp();
  apps.push(app);
  await app.type("const a = 1\nconst b = 2\nconst c = 3");
  await cursorLine(app, 3);
  await app.newTab();
  await app.type("x");
  await cursorLine(app, 1);
  await app.command("tab.previous");
  expect((await cursorLine(app, 3)).ui.cursor).toEqual({ line: 3, column: 12 });
  await Bun.sleep(800);
  await app.quit();

  const again = await launchApp({ userData: app.userData });
  apps.push(again);
  expect((await cursorLine(again, 3)).ui.cursor).toEqual({ line: 3, column: 12 });
});
