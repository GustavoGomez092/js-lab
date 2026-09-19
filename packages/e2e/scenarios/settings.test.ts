import { afterEach, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type LaunchedApp, launchApp } from "../src";

let app: LaunchedApp | null = null;
afterEach(async () => {
  await app?.dispose();
  app = null;
});

/**
 * The substance is "an old settings file is UPGRADED, not discarded": the surviving values are the point.
 *
 * **Why no version is asserted here at all.** This used to assert `version === 3` as a literal, against a
 * `SETTINGS_VERSION` that legitimately changes. The literal had already drifted once -- the test's own name
 * still said "migrated to v2" after the v2→v3 bump -- and drifted again at v3→v4, so a correct change to the app
 * turned this red. Importing the constant instead is not available: `@jslab/shared` is not a dependency of
 * `@jslab/e2e` and does not resolve from it, and adding one would move `bun.lock`.
 *
 * But the replacement is not "compare the version to something symbolic" either, because no version assertion
 * here can fail. `settingsSchema` declares `version: z.literal(SETTINGS_VERSION).catch(SETTINGS_VERSION)`, so a
 * parsed settings object carries the current version unconditionally -- whatever was on disk, and whether or not
 * a migration ran. Measured, not assumed: with `migrateSettings` neutralised to `return input` (no migration at
 * all, no throw), `version` was still reported as 4, the file on disk still said 4, and every version assertion
 * passed. Assertions that cannot fail are worse than none, so they were deleted rather than left in to look like
 * coverage.
 *
 * **What is actually under test.** The regression that matters is data loss, and it runs through the THROW path:
 * `migrateSettings` throws on a version with no migration entry, `loadJson` treats the throw as corruption and
 * substitutes defaults, and every user setting is silently reset. The stored values are what detect that.
 * Mutation-checked by deleting the `3:` entry from packages/shared/src/migrations.ts -- `autoRunDelayMs` then
 * comes back as its schema default (300) instead of the stored 50 and this test fails.
 */
test("an M1 (v1) settings file is migrated on launch and keeps its values (EX-23, LB-02)", async () => {
  app = await launchApp({ settings: { version: 1, run: { autoRunDelayMs: 50, defaultLanguage: "javascript" } } });
  const { ui } = await app.state();

  // Every v1 value survives, and a newer section's defaults are filled in around them rather than over them.
  expect(ui.settings?.run).toMatchObject({ autoRunDelayMs: 50, defaultLanguage: "javascript", formatOnRun: false });

  // The upgrade is durable: the surviving values are on disk, not merely held in memory for this session.
  const onDisk = JSON.parse(await readFile(join(app.userData, "settings.json"), "utf8"));
  expect(onDisk.run).toMatchObject({ autoRunDelayMs: 50, defaultLanguage: "javascript" });
});
