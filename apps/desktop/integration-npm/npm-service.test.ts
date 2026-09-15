import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { npmEnvironment } from "@jslab/npm";
import type { NpmOperation } from "@jslab/rpc-schema";
import { publishStandardFixtures, startTestRegistry, type TestRegistry } from "@jslab/test-registry";
import { resolveAppPaths } from "../src/main/app-paths";
import { NpmService } from "../src/main/services/npm-service";
import { createBunSpawn } from "../src/main/services/npm-spawn";
import { ensurePackagesProject } from "../src/main/services/packages-project";

let registry: TestRegistry;
let root = "";

beforeAll(async () => {
  registry = await startTestRegistry();
  root = await mkdtemp(join(tmpdir(), "jslab-npm-it-"));
  // R-M3-T12-PATH-1: publishStandardFixtures already appends "fixtures" to the work root.
  await publishStandardFixtures(registry.url, root);
});

afterAll(async () => {
  await registry.stop();
  await rm(root, { recursive: true, force: true });
});

async function service(name: string, options: { npmrc?: string; allowScripts?: boolean; baseHome?: string } = {}) {
  const paths = resolveAppPaths({
    resourcesFolder: "/R",
    userData: join(root, name),
    execPath: process.execPath,
    env: {},
  });
  await ensurePackagesProject(paths, () => {});
  await writeFile(paths.packagesNpmrc, options.npmrc ?? `registry=${registry.url}\n`);
  const ops: NpmOperation[] = [];
  const npm = new NpmService({
    paths,
    baseEnv: () => ({
      PATH: process.env.PATH,
      TMPDIR: tmpdir(),
      ...(options.baseHome ? { HOME: options.baseHome } : {}),
    }),
    realHome: join(root, name, "real-home"),
    cacheDirOverride: join(root, name, "cache"),
    settings: () => ({ allowInstallScripts: options.allowScripts ?? false, autoInstallTypes: false }),
    spawn: createBunSpawn(process.execPath),
    onOperation: (op) => ops.push(op),
    onLog: () => {},
    onChanged: () => {},
    afterChange: () => {},
    log: () => {},
  });
  return { npm, paths, ops, last: () => ops.at(-1) };
}

describe("npm service against the test registry (opt-in, spec §22.2)", () => {
  test("M0-S8 discriminating pair: a dead scoped registry in the user's ~/.npmrc breaks a plain install but not JSLab's", async () => {
    const userHome = join(root, "user-home");
    await mkdir(userHome, { recursive: true });
    await writeFile(join(userHome, ".npmrc"), "@jslab-fixture:registry=http://127.0.0.1:9/\n");

    // Control: the bundled Bun with HOME at that user home fails the scoped install.
    const control = join(root, "control");
    await mkdir(control, { recursive: true });
    await writeFile(join(control, "package.json"), JSON.stringify({ name: "control", private: true }));
    await writeFile(join(control, ".npmrc"), `registry=${registry.url}\n`);
    const proc = Bun.spawn([process.execPath, "add", "--exact", "@jslab-fixture/scoped@1.0.0"], {
      cwd: control,
      env: npmEnvironment({
        base: { PATH: process.env.PATH, TMPDIR: tmpdir() },
        npmHome: userHome,
        bunCacheDir: join(root, "control-cache"),
      }),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [controlErr, controlCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    expect(controlCode).not.toBe(0);
    expect(controlErr).toMatch(/ConnectionRefused|ECONNREFUSED/i);

    // JSLab: the same login-shell HOME, but the service overrides HOME with its empty npm-home.
    const { npm, paths, last } = await service("isolated", { baseHome: userHome });
    npm.install("@jslab-fixture/scoped@1.0.0");
    await npm.whenIdle();
    expect(last()).toMatchObject({ status: "succeeded", error: null });
    expect(readdirSync(paths.npmHome)).toEqual([]);
    expect(readFileSync(join(userHome, ".npmrc"), "utf8")).toBe("@jslab-fixture:registry=http://127.0.0.1:9/\n");
  });

  test("install, list with outdated, update and remove", async () => {
    const { npm, last } = await service("lifecycle");
    npm.install("fixture-outdated@1.0.0");
    await npm.whenIdle();
    expect(last()?.status).toBe("succeeded");
    await npm.list({ refreshOutdated: true });
    await npm.whenIdle();
    expect((await npm.list({ refreshOutdated: false })).installed).toEqual([
      { name: "fixture-outdated", version: "1.0.0", latest: "1.1.0" },
    ]);
    npm.update("fixture-outdated");
    await npm.whenIdle();
    expect((await npm.list({ refreshOutdated: false })).installed[0]?.version).toBe("1.1.0");
    npm.remove("fixture-outdated");
    await npm.whenIdle();
    expect((await npm.list({ refreshOutdated: false })).installed).toEqual([]);
  });

  test("install scripts are blocked by default and run once allowed (trustedDependencies)", async () => {
    const off = await service("scripts-off");
    off.npm.install("fixture-script@1.0.0");
    await off.npm.whenIdle();
    expect(off.last()).toMatchObject({ status: "succeeded", notice: "scriptBlocked" });
    expect(existsSync(join(off.paths.packagesNodeModules, "fixture-script", "postinstall-ran.txt"))).toBe(false);

    const on = await service("scripts-on", { allowScripts: true });
    on.npm.install("fixture-script@1.0.0");
    await on.npm.whenIdle();
    expect(on.last()).toMatchObject({ status: "succeeded", notice: null });
    expect(JSON.parse(readFileSync(on.paths.packagesJson, "utf8")).trustedDependencies).toEqual(["fixture-script"]);
    expect(existsSync(join(on.paths.packagesNodeModules, "fixture-script", "postinstall-ran.txt"))).toBe(true);
  });

  test("not-found, no-matching-version and network failures are classified", async () => {
    const { npm, ops } = await service("errors");
    npm.install("jslab-fixture-missing");
    npm.install("fixture-outdated@9.9.9");
    await npm.whenIdle();
    const dead = await service("dead", { npmrc: "registry=http://127.0.0.1:9/\n" });
    dead.npm.install("fixture-outdated@1.0.0");
    await dead.npm.whenIdle();
    expect(ops.filter((op) => op.status === "failed").map((op) => op.error?.kind)).toEqual([
      "notFound",
      "noMatchingVersion",
    ]);
    expect(dead.last()?.error?.kind).toBe("network");
  });

  test("search finds published fixtures", async () => {
    const { npm } = await service("search");
    const response = await npm.search("fixture-outdated");
    expect(response.error).toBeNull();
    expect(response.results.map((result) => result.name)).toContain("fixture-outdated");
  });
});
