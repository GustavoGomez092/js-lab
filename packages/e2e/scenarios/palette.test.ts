import { afterEach, expect, test } from "bun:test";
import { activeTab, type LaunchedApp, launchApp, waitFor } from "../src";

let app: LaunchedApp | null = null;
afterEach(async () => {
  await app?.dispose();
  app = null;
});

test("⌘⇧P opens the palette; typing and Enter run a command; Escape closes (UI direction)", async () => {
  app = await launchApp();
  const current = app;
  await current.key("cmd+shift+p");
  await waitFor(async () => (await current.state()).ui.modal === "palette" || null);
  await current.type("toggle output");
  await current.screenshot("palette-toggle-output");
  await current.key("enter");
  const state = await waitFor(async () => {
    const s = await current.state();
    return s.ui.modal === null && !activeTab(s).layout.outputVisible ? s : null;
  });
  expect(activeTab(state).layout.outputVisible).toBe(false);
  await current.key("cmd+shift+p");
  await waitFor(async () => (await current.state()).ui.modal === "palette" || null);
  await current.key("escape");
  await waitFor(async () => (await current.state()).ui.modal === null || null);
});
