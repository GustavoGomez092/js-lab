import { afterEach, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
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
  const restored = await cursorLine(app, 3);
  expect(restored.ui.cursor).toEqual({ line: 3, column: 12 });
  // FA-m10: wait until this tab's cursor is in session.json instead of sleeping past the 500 ms view-state debounce.
  const firstTabId = restored.ui.activeTabId as string;
  await waitFor(
    async () => {
      const session = JSON.parse(await readFile(join(app.userData, "session.json"), "utf8"));
      const position = session.tabs?.[firstTabId]?.viewState?.cursorState?.[0]?.position;
      return (position?.lineNumber === 3 && position?.column === 12) || null;
    },
    { timeoutMs: 10_000, message: "the first tab's cursor was never persisted" },
  );
  await app.quit();

  const again = await launchApp({ userData: app.userData });
  apps.push(again);
  expect((await cursorLine(again, 3)).ui.cursor).toEqual({ line: 3, column: 12 });
});
