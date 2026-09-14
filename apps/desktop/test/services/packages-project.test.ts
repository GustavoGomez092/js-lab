import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_NPMRC, defaultPackagesManifest } from "@jslab/shared";
import { resolveAppPaths } from "../../src/main/app-paths";
import { ensurePackagesProject } from "../../src/main/services/packages-project";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jslab-packages-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const pathsFor = (root: string) =>
  resolveAppPaths({ resourcesFolder: "/R", userData: root, execPath: "/bun", env: {} });

describe("packages project (spec §11.1, §11.3)", () => {
  test("creates package.json, a 0600 .npmrc and an empty 0700 npm-home, and never overwrites them", async () => {
    const paths = pathsFor(dir);
    const log: string[] = [];
    await ensurePackagesProject(paths, (message) => log.push(message));
    expect(JSON.parse(await readFile(paths.packagesJson, "utf8"))).toEqual(defaultPackagesManifest());
    expect(await readFile(paths.packagesNpmrc, "utf8")).toBe(DEFAULT_NPMRC);
    expect((await stat(paths.packagesNpmrc)).mode & 0o777).toBe(0o600);
    expect((await stat(paths.npmHome)).mode & 0o777).toBe(0o700);
    expect(await readdir(paths.npmHome)).toEqual([]);

    await writeFile(paths.packagesNpmrc, "registry=http://127.0.0.1:4873/\n");
    await ensurePackagesProject(paths, (message) => log.push(message));
    expect(await readFile(paths.packagesNpmrc, "utf8")).toBe("registry=http://127.0.0.1:4873/\n");
    expect(log).toEqual([]);
  });

  test("moves an .npmrc found in npm-home out of it and logs the move (M0-S8)", async () => {
    const paths = pathsFor(dir);
    await mkdir(paths.npmHome, { recursive: true });
    await writeFile(join(paths.npmHome, ".npmrc"), "@scope:registry=http://127.0.0.1:9/\n");
    const log: string[] = [];
    await ensurePackagesProject(
      paths,
      (message) => log.push(message),
      () => 7,
    );
    expect(await readdir(paths.npmHome)).toEqual([]);
    expect(await readFile(join(dir, "npm-home.npmrc.ignored-7"), "utf8")).toContain("@scope:registry");
    expect(log).toHaveLength(1);
  });
});
