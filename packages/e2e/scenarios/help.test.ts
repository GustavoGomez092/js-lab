import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createUserData, type LaunchedApp, launchApp, waitFor } from "../src";

let apps: LaunchedApp[] = [];
afterEach(async () => {
  for (const app of apps.reverse()) await app.dispose();
  apps = [];
});

test("Copy Debug Log produces a redacted report and logs rotate under logs/ (ST-10)", async () => {
  const app = await launchApp();
  apps.push(app);
  await app.command("help.copyDebugLog");
  const clip = join(app.userData, "e2e-clipboard.txt");
  const report = JSON.parse(await waitFor(() => (existsSync(clip) ? readFileSync(clip, "utf8") : null)));
  expect(readFileSync(clip, "utf8")).not.toContain(homedir());
  expect(report).toMatchObject({ electrobunVersion: "2.0.1", arch: "arm64" });
  expect(report.settings.version).toBe(3);
  expect(Array.isArray(report.log)).toBe(true);
  expect(existsSync(join(app.userData, "logs", "main.log"))).toBe(true);
  await app.command("help.openLogsFolder");
  await waitFor(() => existsSync(join(app.userData, "e2e-opened.txt")) || null);
  expect(readFileSync(join(app.userData, "e2e-opened.txt"), "utf8").trim()).toBe(join(app.userData, "logs"));
});

test("Restart in Safe Mode quits and the next launch is in manual Safe Mode", async () => {
  const first = await launchApp();
  apps.push(first);
  await first.command("help.restartSafeMode").catch(() => {});
  await waitFor(() => existsSync(join(first.userData, "safe-mode.next")) || null);
  await first.waitForExit(20_000);
  const second = await launchApp({ userData: first.userData });
  apps.push(second);
  expect((await second.state()).ui.safeMode).toEqual({ active: true, reason: "manual" });
  expect(existsSync(join(second.userData, "safe-mode.next"))).toBe(false);
});

test("a corrupt settings.json is recovered with a notice naming the saved copy (spec §20)", async () => {
  const userData = await createUserData();
  await writeFile(join(userData, "settings.json"), "{not json");
  const app = await launchApp({ userData });
  apps.push(app);
  const notices = (await app.state()).ui.notices as { id: string; message: string }[];
  expect(notices.map((notice) => notice.id)).toEqual(["settingsRecovered"]);
  expect(notices[0]?.message).toMatch(/A copy was saved as settings\.corrupt-\d+\.json$/);
});
