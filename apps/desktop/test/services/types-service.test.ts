import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TypesService } from "../../src/main/services/types-service";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jslab-types-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writePackage(root: string, content: string) {
  await mkdir(join(root, "lib"), { recursive: true });
  await writeFile(join(root, "lib", "package.json"), JSON.stringify({ name: "lib", types: "index.d.ts" }));
  await writeFile(join(root, "lib", "index.d.ts"), content);
}

describe("TypesService", () => {
  test("serves package types from the tab's lookup folders and caches them until invalidated", async () => {
    const modules = join(dir, "packages", "node_modules");
    await writePackage(modules, "export declare const v: 1;\n");
    const service = new TypesService({ nodeModulesDirsFor: () => [modules], workingDirectoryFor: () => null });
    const first = await service.packages("t1", ["lib"]);
    expect(first[0]?.files.find((file) => file.path.endsWith("index.d.ts"))?.content).toContain("v: 1");
    await writePackage(modules, "export declare const v: 2;\n");
    expect(
      (await service.packages("t1", ["lib"]))[0]?.files.find((file) => file.path.endsWith("index.d.ts"))?.content,
    ).toContain("v: 1");
    service.invalidate();
    expect(
      (await service.packages("t1", ["lib"]))[0]?.files.find((file) => file.path.endsWith("index.d.ts"))?.content,
    ).toContain("v: 2");
  });

  test("local types need a working directory and are read fresh each time", async () => {
    const wd = join(dir, "wd");
    await mkdir(wd, { recursive: true });
    await writeFile(join(wd, "util.ts"), "export const a = 1;\n");
    let workingDirectory: string | null = null;
    const service = new TypesService({ nodeModulesDirsFor: () => [], workingDirectoryFor: () => workingDirectory });
    expect(await service.local("t1", ["./util"])).toEqual({ files: [], packages: [], truncated: false });
    workingDirectory = wd;
    expect((await service.local("t1", ["./util"])).files).toEqual([
      { path: "file:///tab/util.ts", content: "export const a = 1;\n" },
    ]);
    await writeFile(join(wd, "util.ts"), "export const a = 2;\n");
    expect((await service.local("t1", ["./util"])).files[0]?.content).toBe("export const a = 2;\n");
  });

  test("excludes a local .d.ts that is a real symlink pointing outside the working directory", async () => {
    const wd = join(dir, "wd");
    const outside = join(dir, "outside");
    await mkdir(wd, { recursive: true });
    await mkdir(outside, { recursive: true });
    const outsideMarker = "OUTSIDE_MARKER_39a12";
    const insideMarker = "INSIDE_MARKER_7cd04";
    await writeFile(join(outside, "secret.d.ts"), `export declare const outsideValue: "${outsideMarker}";\n`);
    await symlink(join(outside, "secret.d.ts"), join(wd, "secret.d.ts"));
    await writeFile(join(wd, "real.d.ts"), `export declare const insideValue: "${insideMarker}";\n`);
    const service = new TypesService({ nodeModulesDirsFor: () => [], workingDirectoryFor: () => wd });
    const result = await service.local("t1", ["./secret", "./real"]);
    expect(result.files.some((file) => file.content.includes(outsideMarker))).toBe(false);
    expect(result.files.some((file) => file.content.includes(insideMarker))).toBe(true);
  });
});
