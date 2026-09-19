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
  // `settingsRecovered` is `info` severity, so it auto-dismisses NOTICE_AUTO_DISMISS_MS (8s) after it mounts
  // (apps/ui/src/shell/parts.tsx) -- by design, per WCAG 2.2.3: a warning or an error never would, only an
  // informational recovery fades. `ui.ready` and `ui.notices` come from the one store commit (`hydrate` in
  // apps/ui/src/state/store.ts), so the notice is guaranteed fresh the instant `launchApp` resolves; a single
  // reading taken right after used to be the whole bug (it could land after the 8s deadline under load). Polling
  // for it closes most of that gap, but the E2E bridge's very first `e2e.state` round trip after a launch can
  // itself go unanswered until *its own* internal 15s timeout (apps/desktop/src/main/cli/e2e-bridge.ts) -- a
  // launch-time race that alone outlasts the notice, which no amount of polling after that one launch can recover
  // from. A fresh launch gives the race a fresh, independent roll, so retry the whole launch (new user data, new
  // corrupt settings.json) rather than only the notice check.
  const maxAttempts = 5;
  let notices: { id: string; message: string }[] | null = null;
  for (let attempt = 0; attempt < maxAttempts && !notices; attempt++) {
    const userData = await createUserData();
    await writeFile(join(userData, "settings.json"), "{not json");
    const app = await launchApp({ userData });
    apps.push(app);
    notices = await waitFor(
      async () => {
        const current = (await app.state()).ui.notices as { id: string; message: string }[];
        return current.length > 0 ? current : null;
      },
      { timeoutMs: 5_000 },
    ).catch(() => null);
  }
  if (!notices) {
    throw new Error(
      `The settingsRecovered notice never appeared before it could auto-dismiss, across ${maxAttempts} launches`,
    );
  }
  expect(notices.map((notice) => notice.id)).toEqual(["settingsRecovered"]);
  expect(notices[0]?.message).toMatch(/A copy was saved as settings\.corrupt-\d+\.json$/);
});
