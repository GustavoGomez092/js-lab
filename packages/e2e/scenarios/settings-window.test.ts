import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createUserData, type LaunchedApp, launchApp, waitFor } from "../src";

let app: LaunchedApp | null = null;
afterEach(async () => {
  await app?.dispose();
  app = null;
});

const current = () => app as LaunchedApp;

async function openSettings() {
  await current().key("cmd+,");
  // A freshly created window loads its bundle first: the same allowance as `reopenWindow` (R-M2-T24-4).
  return waitFor(
    async () => {
      const state = await current().settingsState();
      return state?.ready ? state : null;
    },
    { timeoutMs: 45_000 },
  );
}

describe("Settings window", () => {
  test("⌘, opens the Settings window with its tabs and fields (ST-01, ST-02)", async () => {
    app = await launchApp();
    const state = await openSettings();
    expect(state.tab).toBe("general");
    expect(state.fieldCount).toBe(7);
    expect((await current().state()).main.settingsWindowOpen).toBe(true);
    await current()
      .client.call("e2e.screenshot", { name: "settings-general", window: "settings" })
      .catch(() => {});
    await current().settingsCommand("settings.tab", { tab: "formatting" });
    await waitFor(async () => (await current().settingsState())?.fieldCount === 11 || null);
  });

  test("a change in Settings applies live in the main window and persists (ST-06, ST-07)", async () => {
    app = await launchApp();
    await openSettings();
    await current().settingsCommand("settings.set", { key: "view.statusBar", value: false });
    await current().settingsCommand("settings.set", { key: "appearance.fontSize", value: 20 });
    await waitFor(async () => {
      const ui = (await current().state()).ui;
      const regions = ui.regions as Record<string, boolean>;
      const options = ui.editorOptions as Record<string, unknown>;
      return regions.statusBar === false && options.fontSize === 20 ? ui : null;
    });
    const saved = JSON.parse(await readFile(join(current().userData, "settings.json"), "utf8"));
    expect([saved.view.statusBar, saved.appearance.fontSize]).toEqual([false, 20]);
  });

  test("the font picker lists bundled fonts and installed system fonts (ST-05)", async () => {
    const userData = await createUserData();
    await mkdir(join(userData, "cache"), { recursive: true });
    await writeFile(
      join(userData, "cache", "system-fonts.json"),
      JSON.stringify({ at: Date.now(), fonts: { monospace: ["Seeded Mono"], other: ["Seeded Sans"] } }),
    );
    app = await launchApp({ userData });
    await openSettings();
    const state = await waitFor(async () => {
      const s = await current().settingsState();
      return (s?.fontOptions as string[] | undefined)?.includes("Seeded Mono") ? s : null;
    });
    expect(state.fontOptions).toEqual(
      expect.arrayContaining(["JetBrains Mono", "Fira Code", "Seeded Mono", "Seeded Sans"]),
    );
  });

  test("Reset All Settings restores defaults in both windows (ST-01 Advanced)", async () => {
    app = await launchApp({ settings: { version: 2, editor: { lineWrap: false } } });
    await openSettings();
    await current().settingsCommand("settings.resetAll");
    await waitFor(async () => (await current().state()).ui.settings?.editor.lineWrap === true || null);
    await waitFor(async () => (await current().settingsState())?.settings?.editor.lineWrap === true || null);
  });

  test("the NPM and Build tabs show their fields and apply live (ST-01, LB-05)", async () => {
    app = await launchApp();
    await openSettings();
    await current().settingsCommand("settings.tab", { tab: "build" });
    await waitFor(async () => (await current().settingsState())?.fieldCount === 7 || null);
    await current().settingsCommand("settings.set", { key: "build.pipelineOperator", value: true });
    await waitFor(async () => (await current().state()).ui.settings?.build?.pipelineOperator === true || null);
    await current().settingsCommand("settings.tab", { tab: "npm" });
    await waitFor(async () => (await current().settingsState())?.fieldCount === 2 || null);
  });
});
