import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jslabResolve } from "../../src/main/bundling/resolve-plugin";

let root = "";
let workingDirectory = "";
let packagesNodeModules = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "jslab-resolve-"));
  workingDirectory = join(root, "wd");
  packagesNodeModules = join(root, "pkgs", "node_modules");
  await mkdir(workingDirectory, { recursive: true });
  await mkdir(packagesNodeModules, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writePackage(nodeModulesDir: string, name: string, contents: string) {
  const pkgDir = join(nodeModulesDir, name);
  await mkdir(pkgDir, { recursive: true });
  await writeFile(join(pkgDir, "package.json"), JSON.stringify({ name, main: "index.js" }));
  await writeFile(join(pkgDir, "index.js"), contents);
}

/**
 * Captures the onResolve callback `jslabResolve` registers, so tests can drive it directly without paying for a
 * full `Bun.build`. Mirrors the slice of Bun's `PluginBuilder` the plugin actually calls.
 */
function driveResolve() {
  let callback:
    | ((args: { path: string; importer: string; namespace: string; resolveDir: string; kind: string }) => unknown)
    | null = null;
  const builder = {
    onResolve(_constraints: { filter: RegExp }, cb: typeof callback) {
      callback = cb;
    },
    onLoad() {},
  };
  return {
    builder,
    resolve: async (path: string) => {
      if (!callback) throw new Error("onResolve was never registered");
      return callback({
        path,
        importer: join(workingDirectory, "entry.js"),
        namespace: "file",
        resolveDir: workingDirectory,
        kind: "import-statement",
      });
    },
  };
}

describe("jslabResolve", () => {
  test("resolves a package that exists only in the working directory's node_modules", async () => {
    await writePackage(join(workingDirectory, "node_modules"), "left-pad", "export default 'from-wd';");
    const imports = new Set<string>();
    const { builder, resolve } = driveResolve();
    jslabResolve({ workingDirectory, packagesNodeModules }, imports, () => {}).setup(builder as never);

    const result = (await resolve("left-pad")) as { path: string } | undefined;

    expect(result?.path).toContain(join(workingDirectory, "node_modules", "left-pad"));
    expect(imports.has("left-pad")).toBe(true);
  });

  test("prefers the working directory's node_modules when the same package exists in the packages folder too", async () => {
    await writePackage(join(workingDirectory, "node_modules"), "left-pad", "export default 'from-wd';");
    await writePackage(packagesNodeModules, "left-pad", "export default 'from-pkgs';");
    const { builder, resolve } = driveResolve();
    jslabResolve({ workingDirectory, packagesNodeModules }, new Set(), () => {}).setup(builder as never);

    const result = (await resolve("left-pad")) as { path: string } | undefined;

    expect(result?.path).toContain(join(workingDirectory, "node_modules", "left-pad"));
    expect(result?.path).not.toContain(join(packagesNodeModules, "left-pad"));
  });

  test("falls back to the packages node_modules when the package isn't in the working directory", async () => {
    await writePackage(packagesNodeModules, "right-pad", "export default 'from-pkgs';");
    const { builder, resolve } = driveResolve();
    jslabResolve({ workingDirectory, packagesNodeModules }, new Set(), () => {}).setup(builder as never);

    const result = (await resolve("right-pad")) as { path: string } | undefined;

    expect(result?.path).toContain(join(packagesNodeModules, "right-pad"));
  });

  // Fix round 1, C1: a miss must not defer to Bun's own (ancestor-walking) resolver by returning `undefined` --
  // it must force a failure and report it through `onError`, exactly like a genuinely missing package always did.
  test("fails a bare specifier that exists in neither location, reporting it through onError", async () => {
    const errors: Array<{ specifier?: string }> = [];
    const { builder, resolve } = driveResolve();
    jslabResolve({ workingDirectory, packagesNodeModules }, new Set(), (error) => errors.push(error)).setup(
      builder as never,
    );

    await expect(resolve("totally-missing-pkg")).rejects.toThrow();

    expect(errors).toHaveLength(1);
    expect(errors[0]?.specifier).toBe("totally-missing-pkg");
  });
});
