import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUNDLED_TYPESCRIPT_VERSION,
  collectTypeLibPack,
  jslabTypeLibs,
  MAX_TYPE_LIB_BYTES,
  resolvePackageDir,
  TYPE_LIB_PACKS,
  typesVersionsRangeMatches,
} from "../vite-plugins/type-libs-plugin";

const uiRoot = join(import.meta.dir, "..");
const pack = (name: "node" | "bun") =>
  collectTypeLibPack(TYPE_LIB_PACKS[name].map((pkg) => ({ name: pkg, dir: resolvePackageDir(pkg, uiRoot) })));
/** Rollup's virtual-module marker: a resolved id that starts with a NUL byte. */
const NUL = String.fromCharCode(0);

describe("bundled type libraries (spec §6.2)", () => {
  test("the node and bun packs hold every declaration file and package.json of the pinned packages, within budget", () => {
    const node = pack("node");
    const bun = pack("bun");
    const paths = [...node, ...bun].map((file) => file.path);
    expect(paths).toContain("file:///node_modules/@types/node/package.json");
    expect(paths).toContain("file:///node_modules/@types/node/globals.d.ts");
    expect(paths).toContain("file:///node_modules/undici-types/package.json");
    expect(paths).toContain("file:///node_modules/bun-types/package.json");
    expect(paths.some((path) => path.startsWith("file:///node_modules/bun-types/") && path.endsWith(".d.ts"))).toBe(
      true,
    );
    expect(paths.every((path) => path.endsWith(".d.ts") || path.endsWith("/package.json"))).toBe(true);
    const bytes = [...node, ...bun].reduce((sum, file) => sum + Buffer.byteLength(file.content, "utf8"), 0);
    expect(bytes).toBeLessThan(MAX_TYPE_LIB_BYTES);
    expect(
      JSON.parse(node.find((file) => file.path.endsWith("@types/node/package.json"))?.content ?? "{}").version,
    ).toBe("22.20.2");
  });

  test("the Vite plugin serves each pack as a virtual module and ignores other ids", async () => {
    const plugin = jslabTypeLibs(uiRoot);
    const resolveId = plugin.resolveId as (id: string) => string | null;
    const load = plugin.load as (id: string) => string | null;
    expect(resolveId("virtual:jslab-type-libs/bun")).toBe(`${NUL}virtual:jslab-type-libs/bun`);
    expect(resolveId("./other")).toBeNull();
    const code = load(`${NUL}virtual:jslab-type-libs/bun`) ?? "";
    expect(code.startsWith("export default [")).toBe(true);
    expect(load(`${NUL}something-else`)).toBeNull();
    // An inherited Object.prototype key is not a pack.
    expect(load(resolveId("virtual:jslab-type-libs/constructor") ?? "")).toBeNull();
  });

  test("the pinned TypeScript version matches the one Monaco bundles", async () => {
    const monacoDir = resolvePackageDir("monaco-editor", uiRoot);
    const content = await readFile(
      join(monacoDir, "esm/vs/languages/features/typescript/lib/typescriptServices.js"),
      "utf8",
    );
    // Task 23 fix round 2, M-7: the full patch version, not versionMajorMinor — TypeScript compares typesVersions
    // ranges against its full version, and a patch-level range matters (Monaco's real TypeScript here is 5.9.3).
    const match = /\bversion\s*=\s*"([^"]+)"/.exec(content);
    expect(match?.[1]).toBe(BUNDLED_TYPESCRIPT_VERSION);
  });

  test("runtime packs leave out declarations for other TypeScript versions", () => {
    const node = pack("node");
    const bun = pack("bun");
    const paths = [...node, ...bun].map((file) => file.path);
    expect(paths.some((path) => path.includes("/bun-types/ts7.1/"))).toBe(false);
    expect(paths.some((path) => path.includes("/@types/node/ts5.6/"))).toBe(false);
    expect(paths).toContain("file:///node_modules/bun-types/index.d.ts");
    expect(paths).toContain("file:///node_modules/@types/node/index.d.ts");
  });

  test("typesVersions ranges are matched in order, and unsupported entries fail loudly", async () => {
    // Task 23 fix round 2, M-7: compared against the full 5.9.3 pin, not just 5.9 (5.9.0). Two rows change from the
    // fix-round-1 truth table: ">5.9.0" and ">=5.9.1" are now true, since 5.9.3's patch (3) is greater than both
    // ranges' patch component (0 and 1) — a range with no patch still treats a missing patch as 0 on both sides.
    expect(typesVersionsRangeMatches("*", "5.9.3")).toBe(true);
    expect(typesVersionsRangeMatches(">=7.1", "5.9.3")).toBe(false);
    expect(typesVersionsRangeMatches("<=5.6", "5.9.3")).toBe(false);
    expect(typesVersionsRangeMatches("<6", "5.9.3")).toBe(true);
    expect(typesVersionsRangeMatches("5.9", "5.9.3")).toBe(true);
    expect(typesVersionsRangeMatches(">5.9.0", "5.9.3")).toBe(true);
    expect(typesVersionsRangeMatches(">=5.9.1", "5.9.3")).toBe(true);
    expect(() => typesVersionsRangeMatches(">=4.0 || <3", "5.9.3")).toThrow(/>=4.0 \|\| <3/);

    const excludeDir = await mkdtemp(join(tmpdir(), "jslab-typelibs-exclude-"));
    try {
      await writeFile(
        join(excludeDir, "package.json"),
        JSON.stringify({
          name: "fixture-exclude",
          version: "0.0.0",
          typesVersions: { ">=99.0": { "*": ["ts99/*"] } },
        }),
      );
      await writeFile(join(excludeDir, "index.d.ts"), "export {};");
      await mkdir(join(excludeDir, "ts99"), { recursive: true });
      await writeFile(join(excludeDir, "ts99", "extra.d.ts"), "export {};");
      const files = collectTypeLibPack([{ name: "fixture-exclude", dir: excludeDir }]);
      const paths = files.map((file) => file.path);
      expect(paths).toContain("file:///node_modules/fixture-exclude/index.d.ts");
      expect(paths.some((path) => path.includes("/ts99/"))).toBe(false);
    } finally {
      await rm(excludeDir, { recursive: true, force: true });
    }

    const redirectDir = await mkdtemp(join(tmpdir(), "jslab-typelibs-redirect-"));
    try {
      await writeFile(
        join(redirectDir, "package.json"),
        JSON.stringify({
          name: "fixture-redirect",
          version: "0.0.0",
          typesVersions: { "*": { "*": ["redirect/*"] } },
        }),
      );
      await writeFile(join(redirectDir, "index.d.ts"), "export {};");
      expect(() => collectTypeLibPack([{ name: "fixture-redirect", dir: redirectDir }])).toThrow(
        /typesVersions entry "\*" for TypeScript 5\.9/,
      );
    } finally {
      await rm(redirectDir, { recursive: true, force: true });
    }

    // Task 23 fix round 2, M-6: a leading "./" is normalised away before the first path segment is taken.
    const dotSlashDir = await mkdtemp(join(tmpdir(), "jslab-typelibs-dotslash-"));
    try {
      await writeFile(
        join(dotSlashDir, "package.json"),
        JSON.stringify({
          name: "fixture-dotslash",
          version: "0.0.0",
          typesVersions: { ">=99.0": { "*": ["./ts99/*"] } },
        }),
      );
      await writeFile(join(dotSlashDir, "index.d.ts"), "export {};");
      await mkdir(join(dotSlashDir, "ts99"), { recursive: true });
      await writeFile(join(dotSlashDir, "ts99", "extra.d.ts"), "export {};");
      const files = collectTypeLibPack([{ name: "fixture-dotslash", dir: dotSlashDir }]);
      const paths = files.map((file) => file.path);
      expect(paths).toContain("file:///node_modules/fixture-dotslash/index.d.ts");
      expect(paths.some((path) => path.includes("/ts99/"))).toBe(false);
    } finally {
      await rm(dotSlashDir, { recursive: true, force: true });
    }

    // M-6: a target whose first segment would be "." (the package root) throws, instead of dropping every file.
    const dotOnlyDir = await mkdtemp(join(tmpdir(), "jslab-typelibs-dotonly-"));
    try {
      await writeFile(
        join(dotOnlyDir, "package.json"),
        JSON.stringify({ name: "fixture-dotonly", version: "0.0.0", typesVersions: { ">=99.0": { "*": ["."] } } }),
      );
      await writeFile(join(dotOnlyDir, "index.d.ts"), "export {};");
      expect(() => collectTypeLibPack([{ name: "fixture-dotonly", dir: dotOnlyDir }])).toThrow(/package root/);
    } finally {
      await rm(dotOnlyDir, { recursive: true, force: true });
    }

    // M-6: excluding the directory holding the package's own "types" entry throws.
    const typesDir = await mkdtemp(join(tmpdir(), "jslab-typelibs-types-"));
    try {
      await writeFile(
        join(typesDir, "package.json"),
        JSON.stringify({
          name: "fixture-types",
          version: "0.0.0",
          types: "dist/index.d.ts",
          typesVersions: { ">=99.0": { "*": ["dist/legacy.d.ts"] } },
        }),
      );
      await mkdir(join(typesDir, "dist"), { recursive: true });
      await writeFile(join(typesDir, "dist", "index.d.ts"), "export {};");
      expect(() => collectTypeLibPack([{ name: "fixture-types", dir: typesDir }])).toThrow(/types entry/);
    } finally {
      await rm(typesDir, { recursive: true, force: true });
    }
  });
});
