import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectPackageTypes, type TypesFs } from "@jslab/npm";
import { nodeTypesFs, TypesService } from "../../src/main/services/types-service";

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

  // M-6: the package cache is bounded, evicting the least recently used entry once it would grow past the cap.
  test("the package types cache keeps at most 200 entries and evicts the least recently used", async () => {
    const modules = "/packages/node_modules";
    const manifestReads: string[] = [];
    const fakeFs: TypesFs = {
      async readText(path) {
        if (path.endsWith("/package.json")) {
          manifestReads.push(path);
          const name = path.slice(modules.length + 1, path.length - "/package.json".length);
          return JSON.stringify({ name, types: "index.d.ts" });
        }
        if (path.endsWith("/index.d.ts")) return "export declare const v: 1;\n";
        return null;
      },
      async isFile(path) {
        return path.endsWith("/package.json") || path.endsWith("/index.d.ts");
      },
      async realpath(path) {
        return path;
      },
    };
    const service = new TypesService({
      nodeModulesDirsFor: () => [modules],
      workingDirectoryFor: () => null,
      fs: fakeFs,
    });

    await service.packages("t1", ["pkg0"]);
    for (let i = 1; i < 200; i++) await service.packages("t1", [`pkg${i}`]);
    // The cache now holds pkg0..pkg199 (200 entries, at the cap).

    manifestReads.length = 0;
    await service.packages("t1", ["pkg0"]); // Refresh pkg0's recency: it's now the most recently used.
    expect(manifestReads).toEqual([]);

    await service.packages("t1", ["pkg200"]); // The 201st distinct entry evicts the least recently used: pkg1.

    manifestReads.length = 0;
    await service.packages("t1", ["pkg1"]);
    expect(manifestReads.length).toBeGreaterThan(0); // Evicted: went back to the fs.

    manifestReads.length = 0;
    await service.packages("t1", ["pkg0"]);
    expect(manifestReads).toEqual([]); // Still cached: the refresh above kept it.
  });

  // #3: opening a FIFO must never hang (regression from fix round 1's M-2 open-before-fstat change).
  // N6: races the collectPackageTypes half against its own bound, independent of the per-test timeout, and adds a
  // real `index.d.ts` next to the FIFO `package.json` so `hasTypes: false` can only come from the FIFO manifest.
  test("reading a FIFO returns null without hanging", async () => {
    const fifoDir = await mkdtemp(join(tmpdir(), "jslab-types-fifo-"));
    try {
      const fifoPath = join(fifoDir, "fifo");
      const mkfifo1 = Bun.spawn(["mkfifo", fifoPath]);
      await mkfifo1.exited;

      const result = await nodeTypesFs.readText(fifoPath);
      expect(result).toBeNull();

      const pkgDir = join(fifoDir, "node_modules", "lib");
      await mkdir(pkgDir, { recursive: true });
      const pkgJsonFifo = join(pkgDir, "package.json");
      const mkfifo2 = Bun.spawn(["mkfifo", pkgJsonFifo]);
      await mkfifo2.exited;
      await writeFile(join(pkgDir, "index.d.ts"), "export declare const v: 1;\n");

      let timer: ReturnType<typeof setTimeout> | undefined;
      const bound = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("collectPackageTypes did not resolve within 2000ms")), 2000);
      });
      const pkgResult = await Promise.race([
        collectPackageTypes(nodeTypesFs, { name: "lib", nodeModulesDirs: [join(fifoDir, "node_modules")] }),
        bound,
      ]);
      clearTimeout(timer);
      expect(pkgResult.hasTypes).toBe(false);
      expect(pkgResult.typesPackage).toBeNull();
    } finally {
      await rm(fifoDir, { recursive: true, force: true });
    }
  }, 5000);
});
