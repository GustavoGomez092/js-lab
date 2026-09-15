import { afterEach, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createUserData, type LaunchedApp, launchApp, waitFor } from "../src";

let app: LaunchedApp | null = null;
afterEach(async () => {
  await app?.dispose();
  app = null;
});

interface NpmSnapshot {
  installed: { name: string; version: string | null; latest: string | null }[];
  outdatedError: string | null;
}

async function writePackage(userData: string, name: string, version: string) {
  const dir = join(userData, "packages", "node_modules", name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "package.json"), JSON.stringify({ name, version }));
}

test("⌘I opens the installed table from the packages project; a dead registry reports a network hint (TL-01, TL-06, TL-09)", async () => {
  const userData = await createUserData();
  await mkdir(join(userData, "packages"), { recursive: true });
  await writeFile(
    join(userData, "packages", "package.json"),
    JSON.stringify({
      name: "jslab-packages",
      private: true,
      dependencies: { "fixture-a": "1.0.0", "@types/fixture-a": "1.0.0" },
      trustedDependencies: [],
    }),
  );
  await writePackage(userData, "fixture-a", "1.0.0");
  await writePackage(userData, "@types/fixture-a", "1.0.0");
  // No registry is ever contacted: a dead local port (R-M3-NET-1) forces the outdated check's network hint.
  await writeFile(join(userData, "packages", ".npmrc"), "registry=http://127.0.0.1:9/\n");
  // The E2E Bun cache stays inside the scenario's own data dir, never the user's real Bun cache.
  app = await launchApp({ userData, env: { JSLAB_E2E_BUN_CACHE_DIR: join(userData, "bun-cache") } });
  const current = app;
  await current.key("cmd+i");
  const npm = await waitFor(
    async () => {
      const ui = (await current.state()).ui;
      const snapshot = ui.npm as NpmSnapshot;
      return ui.modal === "npm" && snapshot.outdatedError ? snapshot : null;
    },
    { timeoutMs: 90_000, message: "the outdated check never reported" },
  );
  expect(npm.installed).toEqual([
    { name: "@types/fixture-a", version: "1.0.0", latest: null },
    { name: "fixture-a", version: "1.0.0", latest: null },
  ]);
  expect(npm.outdatedError).toBe("network");
  await current.key("escape");
  await waitFor(async () => (await current.state()).ui.modal === null || null);
});
