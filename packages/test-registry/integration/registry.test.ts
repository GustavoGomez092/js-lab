import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { npmEnvironment } from "@jslab/npm";
import { defaultPackagesManifest } from "@jslab/shared";
import { isAlive, publishStandardFixtures, startTestRegistry, type TestRegistry } from "../src";

let registry: TestRegistry;
let work = "";

beforeAll(async () => {
  registry = await startTestRegistry();
  work = await mkdtemp(join(tmpdir(), "jslab-registry-work-"));
  await publishStandardFixtures(registry.url, work);
});

afterAll(async () => {
  await registry.stop();
  await rm(work, { recursive: true, force: true });
});

describe("test registry (opt-in)", () => {
  test("serves published fixtures, including a second version as latest", async () => {
    const packument = (await (await fetch(`${registry.url}fixture-outdated`)).json()) as {
      "dist-tags": { latest: string };
      versions: Record<string, unknown>;
    };
    expect(packument["dist-tags"].latest).toBe("1.1.0");
    expect(Object.keys(packument.versions).sort()).toEqual(["1.0.0", "1.1.0"]);
  });

  test("the bundled Bun installs a scoped fixture from it with an isolated HOME and a temp cache", async () => {
    const project = join(work, "project");
    const home = join(work, "npm-home");
    await mkdir(project, { recursive: true });
    await mkdir(home, { recursive: true });
    await writeFile(join(project, "package.json"), JSON.stringify(defaultPackagesManifest()));
    await writeFile(join(project, ".npmrc"), `registry=${registry.url}\n`);
    const proc = Bun.spawn([process.execPath, "add", "--exact", "@jslab-fixture/scoped@1.0.0"], {
      cwd: project,
      env: npmEnvironment({
        base: { PATH: process.env.PATH, TMPDIR: tmpdir() },
        npmHome: home,
        bunCacheDir: join(work, "cache"),
      }),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await proc.exited).toBe(0);
    const manifest = JSON.parse(await readFile(join(project, "package.json"), "utf8"));
    expect(manifest.dependencies).toEqual({ "@jslab-fixture/scoped": "1.0.0" });
  });

  test("stop() ends the tracked PID", async () => {
    const extra = await startTestRegistry();
    expect(isAlive(extra.pid)).toBe(true);
    await extra.stop();
    expect(isAlive(extra.pid)).toBe(false);
  });
});
