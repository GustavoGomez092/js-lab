import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { activeTab, type LaunchedApp, launchApp, waitFor } from "../src";

let app: LaunchedApp | null = null;
afterEach(async () => {
  await app?.dispose();
  app = null;
});

test("Environment Variables: add, save to a 0600 env.json, read in the next run, and kept out of the debug report (TL-11)", async () => {
  app = await launchApp({ settings: { version: 3, run: { autoRun: false } } });
  const current = app;
  await current.command("tools.environmentVariables");
  await waitFor(async () => (await current.state()).ui.modal === "env" || null);
  await current.type("E2E_GREETING");
  await current.key("enter");
  await current.type("hello-from-env");
  await current.key("enter");
  await current.key("cmd+enter");
  await waitFor(async () => (await current.state()).ui.modal === null || null, { message: "the sheet never closed" });
  const envFile = join(current.userData, "env.json");
  expect(JSON.parse(readFileSync(envFile, "utf8"))).toEqual({
    version: 1,
    variables: { E2E_GREETING: "hello-from-env" },
  });
  expect((await stat(envFile)).mode & 0o777).toBe(0o600);
  await current.type("console.log(process.env.E2E_GREETING)");
  await waitFor(async () => activeTab(await current.state()).code === "console.log(process.env.E2E_GREETING)" || null);
  await current.command("run.start");
  await current.waitForOutput(
    (entries) => entries.some((entry) => entry.kind === "console" && entry.text === "hello-from-env"),
    30_000,
  );
  await current.command("help.copyDebugLog");
  const clip = join(current.userData, "e2e-clipboard.txt");
  const report = await waitFor(() => (existsSync(clip) ? readFileSync(clip, "utf8") : null));
  // Fix round 1 (N-4): a positive control, so an empty or truncated report couldn't pass the absence check
  // below by accident.
  const parsed = JSON.parse(report);
  expect(typeof parsed.version).toBe("string");
  expect(Array.isArray(parsed.log)).toBe(true);
  expect(report).not.toContain("hello-from-env");
});
