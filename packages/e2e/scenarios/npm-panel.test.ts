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

const NL = String.fromCharCode(10);

/**
 * R-M3-T26-FIX-1 (ruling): `bun outdated` never contacts the registry when `<packages>/bun.lock` is missing —
 * it fails at once with "missing lockfile" (a non-network error), which is what a hand-seeded `node_modules`
 * with no lockfile always hits. This is a real lockfile, generated once (Bun 1.4.0, the E2E build's own bundled
 * binary, via a throwaway loopback responder, never the public registry) for fixture-a and @types/fixture-a, then
 * pasted here as a literal. Seeding it lets `bun outdated` reach a real connection attempt against the dead
 * registry below, instead of failing before ever attempting one.
 * N-5: the lockfile's own tarball URLs (127.0.0.1:4900) are never fetched here — node_modules is already
 * seeded, and `bun outdated` reads only package manifests from `.npmrc`'s registry, never a tarball.
 * R-M3-OUTDATED-1 (outdated-1-analysis.md §2.3): this lockfile needs the app's bundled Bun (>= 1.4.0). Bun 1.3.13
 * rejects `"lockfileVersion": 2` before any network I/O ("Unknown lockfile version"), which would classify as
 * `unknown`, not `network` — a different scenario than the one this test exercises.
 */
const FIXTURE_BUN_LOCK =
  [
    "{",
    '  "lockfileVersion": 2,',
    '  "configVersion": 1,',
    '  "workspaces": {',
    '    "": {',
    '      "name": "jslab-packages",',
    '      "dependencies": {',
    '        "@types/fixture-a": "1.0.0",',
    '        "fixture-a": "1.0.0",',
    "      },",
    "    },",
    "  },",
    '  "packages": {',
    '    "@types/fixture-a": ["@types/fixture-a@1.0.0", "http://127.0.0.1:4900/@types/fixture-a/-/fixture-a-1.0.0.tgz", {}, "sha1-cVpFoM1CIh1bC55saKqtOvICAh0="],',
    "",
    '    "fixture-a": ["fixture-a@1.0.0", "http://127.0.0.1:4900/fixture-a/-/fixture-a-1.0.0.tgz", {}, "sha1-lhe0XEIxgNU0SUtnC6NVpOI/EEM="],',
    "  }",
    "}",
  ].join(NL) + NL;

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
  // Fix round 1 (R-M3-T26-FIX-1): without a lockfile, `bun outdated` never reaches the network (see FIXTURE_BUN_LOCK).
  await writeFile(join(userData, "packages", "bun.lock"), FIXTURE_BUN_LOCK);
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

  // R-M3-OUTDATED-1: reopening the sheet exercises the cached-response path (the 10-minute TTL means no new
  // refresh runs), which stays order-independent regardless of the delivery-race fix above.
  await current.key("cmd+i");
  const reopened = await waitFor(
    async () => {
      const ui = (await current.state()).ui;
      const snapshot = ui.npm as NpmSnapshot;
      return ui.modal === "npm" && snapshot.outdatedError ? snapshot : null;
    },
    { timeoutMs: 90_000, message: "the reopened sheet never reported the cached outdated error" },
  );
  expect(reopened.outdatedError).toBe("network");
});
