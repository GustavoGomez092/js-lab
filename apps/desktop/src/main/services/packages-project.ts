import { existsSync } from "node:fs";
import { chmod, mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_NPMRC, defaultPackagesManifest } from "@jslab/shared";
import type { AppPaths } from "../app-paths";
import { writeFileAtomic } from "../persistence/atomic-write";
import { strings } from "../strings";

export type PackagesProjectPaths = Pick<
  AppPaths,
  "dataDir" | "packagesDir" | "packagesJson" | "packagesNpmrc" | "npmHome"
>;

/**
 * Creates the shared npm project (spec §11.1) and the empty npm-home (§11.3, M0-S8) when missing. Existing files are
 * never overwritten. An .npmrc inside npm-home would defeat the isolation, so it is moved out and logged.
 */
export async function ensurePackagesProject(
  paths: PackagesProjectPaths,
  log: (message: string, detail?: unknown) => void,
  now: () => number = Date.now,
): Promise<void> {
  await mkdir(paths.packagesDir, { recursive: true });
  if (!existsSync(paths.packagesJson)) {
    await writeFileAtomic(paths.packagesJson, `${JSON.stringify(defaultPackagesManifest(), null, 2)}\n`);
  }
  if (!existsSync(paths.packagesNpmrc)) await writeFileAtomic(paths.packagesNpmrc, DEFAULT_NPMRC, { mode: 0o600 });
  await mkdir(paths.npmHome, { recursive: true, mode: 0o700 });
  await chmod(paths.npmHome, 0o700);
  const stray = join(paths.npmHome, ".npmrc");
  if (existsSync(stray)) {
    const moved = join(paths.dataDir, `npm-home.npmrc.ignored-${now()}`);
    await rename(stray, moved);
    log(strings.log.npmHomeNpmrcMoved(moved));
  }
}
