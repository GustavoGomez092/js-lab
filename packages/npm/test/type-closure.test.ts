import { describe, expect, test } from "bun:test";
import {
  collectLocalTypes,
  collectPackageTypes,
  MAX_DECLARED_TYPE_ENTRIES,
  MAX_LOCAL_TYPE_FILES,
  MAX_PACKAGE_TYPE_FILES,
  type TypesFs,
} from "../src/type-closure";

/**
 * `unresolvable` forces `realpath` to null for specific paths (M-1). A path is treated as an existing directory
 * (resolving to itself) when some file or link key lies under it, matching how a real filesystem's `realpath`
 * behaves for an ordinary (non-symlinked) directory.
 */
function memoryFs(
  files: Record<string, string>,
  links: Record<string, string> = {},
  unresolvable: readonly string[] = [],
): TypesFs {
  const isDir = (path: string) =>
    Object.keys(files).some((f) => f.startsWith(`${path}/`)) ||
    Object.keys(links).some((l) => l.startsWith(`${path}/`));
  return {
    readText: async (path) => files[path] ?? (path in links ? (files[links[path] as string] ?? null) : null),
    isFile: async (path) => path in files || path in links,
    realpath: async (path) => {
      if (unresolvable.includes(path)) return null;
      if (path in links) return links[path] as string;
      if (path in files) return path;
      return isDir(path) ? path : null;
    },
  };
}

/** Wraps a `TypesFs`, recording every `isFile`/`readText`/`realpath` path so tests can assert probe/read counts. */
function countingFs(
  fs: TypesFs,
): TypesFs & { isFileCalls: string[]; readTextCalls: string[]; realpathCalls: string[] } {
  const isFileCalls: string[] = [];
  const readTextCalls: string[] = [];
  const realpathCalls: string[] = [];
  return {
    isFileCalls,
    readTextCalls,
    realpathCalls,
    readText: async (path) => {
      readTextCalls.push(path);
      return fs.readText(path);
    },
    isFile: async (path) => {
      isFileCalls.push(path);
      return fs.isFile(path);
    },
    realpath: (path) => {
      realpathCalls.push(path);
      return fs.realpath(path);
    },
  };
}

describe("package type closure (spec §6.2)", () => {
  test("follows types, relative imports and reference paths, lists bare dependencies and includes package.json", async () => {
    const fs = memoryFs({
      "/wd/node_modules/lib/package.json": JSON.stringify({ name: "lib", types: "dist/index.d.ts" }),
      "/wd/node_modules/lib/dist/index.d.ts":
        '/// <reference path="./globals.d.ts" />\nexport * from "./parts/a.js";\nimport type { X } from "other-lib";\nexport type { X };\n',
      "/wd/node_modules/lib/dist/globals.d.ts": "declare const LIB_VERSION: string;\n",
      "/wd/node_modules/lib/dist/parts/a.d.ts": 'export declare function a(): import("./b").B;\n',
      "/wd/node_modules/lib/dist/parts/b.d.ts": "export interface B { ok: true }\n",
      "/app/node_modules/lib/package.json": JSON.stringify({ name: "lib", types: "shadowed.d.ts" }),
    });
    const result = await collectPackageTypes(fs, {
      name: "lib",
      nodeModulesDirs: ["/wd/node_modules", "/app/node_modules"],
    });
    expect(result.files.map((file) => file.path).sort()).toEqual([
      "file:///node_modules/lib/dist/globals.d.ts",
      "file:///node_modules/lib/dist/index.d.ts",
      "file:///node_modules/lib/dist/parts/a.d.ts",
      "file:///node_modules/lib/dist/parts/b.d.ts",
      "file:///node_modules/lib/package.json",
    ]);
    expect(result).toMatchObject({
      name: "lib",
      dependencies: ["other-lib"],
      typesPackage: null,
      hasTypes: true,
      truncated: false,
    });
  });

  test("reads types conditions in exports and maps .cjs to .d.cts", async () => {
    const fs = memoryFs({
      "/n/zodish/package.json": JSON.stringify({
        name: "zodish",
        exports: {
          ".": { types: "./index.d.cts", import: "./index.js" },
          "./v4": { import: { types: "./v4/index.d.ts" } },
        },
      }),
      "/n/zodish/index.d.cts": 'export * from "./classic/external.cjs";\n',
      "/n/zodish/classic/external.d.cts": "export declare const z: { string(): unknown };\n",
      "/n/zodish/v4/index.d.ts": "export {};\n",
    });
    const result = await collectPackageTypes(fs, { name: "zodish", nodeModulesDirs: ["/n"] });
    expect(result.files.map((file) => file.path).sort()).toEqual([
      "file:///node_modules/zodish/classic/external.d.cts",
      "file:///node_modules/zodish/index.d.cts",
      "file:///node_modules/zodish/package.json",
      "file:///node_modules/zodish/v4/index.d.ts",
    ]);
  });

  test("falls back to an installed @types package, offers one that isn't installed, and returns nothing for a missing package", async () => {
    const withTypes = memoryFs({
      "/n/untyped/package.json": JSON.stringify({ name: "untyped", main: "index.js" }),
      "/n/@types/untyped/package.json": JSON.stringify({ name: "@types/untyped", types: "index.d.ts" }),
      "/n/@types/untyped/index.d.ts": "export declare const untyped: string;\n",
    });
    const typed = await collectPackageTypes(withTypes, { name: "untyped", nodeModulesDirs: ["/n"] });
    expect(typed).toMatchObject({ hasTypes: true, typesPackage: "@types/untyped" });
    expect(typed.files.map((file) => file.path)).toContain("file:///node_modules/@types/untyped/index.d.ts");

    const without = memoryFs({ "/n/untyped/package.json": JSON.stringify({ name: "untyped", main: "index.js" }) });
    expect(await collectPackageTypes(without, { name: "untyped", nodeModulesDirs: ["/n"] })).toEqual({
      name: "untyped",
      files: [],
      dependencies: [],
      typesPackage: "@types/untyped",
      hasTypes: false,
      truncated: false,
    });
    expect((await collectPackageTypes(without, { name: "missing", nodeModulesDirs: ["/n"] })).typesPackage).toBeNull();
  });

  test("stops at the byte cap and says so", async () => {
    const fs = memoryFs({
      "/n/big/package.json": JSON.stringify({ name: "big", types: "a.d.ts" }),
      "/n/big/a.d.ts": `export * from "./b";\n${"x".repeat(600)}`,
      "/n/big/b.d.ts": "y".repeat(600),
    });
    const result = await collectPackageTypes(fs, { name: "big", nodeModulesDirs: ["/n"], maxBytes: 1000 });
    expect(result.truncated).toBe(true);
    expect(result.files.map((file) => file.path)).not.toContain("file:///node_modules/big/b.d.ts");
  });

  test("excludes a package .d.ts that is a symlink pointing outside the package, and anything only reached through it", async () => {
    const fs = memoryFs(
      {
        "/n/lib/package.json": JSON.stringify({ name: "lib", types: "index.d.ts" }),
        "/n/lib/index.d.ts": 'export * from "./escape";\n',
        "/outside/escape.d.ts": 'import type { Y } from "leaked-dep";\nexport type { Y };\n',
      },
      { "/n/lib/escape.d.ts": "/outside/escape.d.ts" },
    );
    const result = await collectPackageTypes(fs, { name: "lib", nodeModulesDirs: ["/n"] });
    expect(result.files.map((file) => file.path).sort()).toEqual([
      "file:///node_modules/lib/index.d.ts",
      "file:///node_modules/lib/package.json",
    ]);
    expect(result.dependencies).toEqual([]);
  });

  test("a package closure stops at MAX_PACKAGE_TYPE_FILES and reports truncated", async () => {
    const count = MAX_PACKAGE_TYPE_FILES + 1;
    const files: Record<string, string> = {
      "/n/huge/package.json": JSON.stringify({ name: "huge", types: "index.d.ts" }),
    };
    const lines: string[] = [];
    for (let i = 0; i < count; i++) {
      lines.push(`export * from "./f${i}";`);
      files[`/n/huge/f${i}.d.ts`] = `export declare const v${i}: number;\n`;
    }
    files["/n/huge/index.d.ts"] = `${lines.join("\n")}\n`;
    const fs = memoryFs(files);
    const result = await collectPackageTypes(fs, { name: "huge", nodeModulesDirs: ["/n"] });
    expect(result.files.length).toBe(MAX_PACKAGE_TYPE_FILES);
    expect(result.truncated).toBe(true);
  });

  // I-2: package.json read is gated on the real path too, not just the .d.ts closure.
  test("a package.json symlinked outside the package is ignored", async () => {
    const fs = memoryFs(
      {
        "/n/node_modules/lib/index.d.ts": "export declare const v: 1;\n",
        "/outside/package.json": JSON.stringify({ name: "lib", types: "index.d.ts" }),
      },
      { "/n/node_modules/lib/package.json": "/outside/package.json" },
    );
    const result = await collectPackageTypes(fs, { name: "lib", nodeModulesDirs: ["/n/node_modules"] });
    expect(result.hasTypes).toBe(false);
    expect(result.files).toEqual([]);
  });

  // I-3: `/// <reference types>` values are validated as package names, and a package never lists itself.
  test("reference types values that aren't package names never become dependencies", async () => {
    const fs = memoryFs({
      "/n/lib/package.json": JSON.stringify({ name: "lib", types: "index.d.ts" }),
      "/n/lib/index.d.ts":
        '/// <reference types="../../../../Users/someone/project" />\n' +
        '/// <reference types="lib" />\n' +
        '/// <reference types="dep-ok" />\n',
    });
    const result = await collectPackageTypes(fs, { name: "lib", nodeModulesDirs: ["/n"] });
    expect(result.dependencies).toEqual(["dep-ok"]);
  });

  // I-3: `collectPackageTypes` refuses a `name` that isn't itself a valid package name, before touching the fs.
  test("collectPackageTypes refuses names that aren't package names", async () => {
    const fs = countingFs(
      memoryFs({
        "/n/node_modules/other/package.json": JSON.stringify({ name: "other", types: "index.d.ts" }),
        "/n/node_modules/other/index.d.ts": "export {};\n",
      }),
    );
    const result = await collectPackageTypes(fs, { name: "../other", nodeModulesDirs: ["/n/node_modules"] });
    expect(result.files).toEqual([]);
    expect(result.hasTypes).toBe(false);
    expect(fs.readTextCalls).toEqual([]);
  });

  // #1: manifest-declared entries are capped and deduped, and share closure()'s probe budget.
  test("manifest types entries are capped and share the probe budget", async () => {
    const exportsField: Record<string, unknown> = {};
    for (let i = 0; i < 5000; i++) exportsField[`./e${i}`] = { types: `./e${i}` };
    const fs = countingFs(
      memoryFs({
        "/n/lib/package.json": JSON.stringify({ name: "lib", exports: exportsField }),
      }),
    );
    const result = await collectPackageTypes(fs, { name: "lib", nodeModulesDirs: ["/n"] });
    expect(fs.isFileCalls.length).toBeLessThanOrEqual(MAX_DECLARED_TYPE_ENTRIES * 4);
    expect(result.hasTypes).toBe(false);
  });

  // #2: a manifest entry pointing outside the package is never probed, and yields no types.
  // N6: also covers a prefix-sibling entry (`/n/orc-evil`), which only a trailing-slash-safe filter rejects.
  test("manifest types outside the package are never probed and give no types", async () => {
    const dir = "/n/orc";
    const fs = countingFs(
      memoryFs({
        "/n/orc/package.json": JSON.stringify({
          name: "orc",
          types: "../../secret/x.d.ts",
          exports: { "./a": { types: "../orc-evil/x.d.ts" } },
        }),
        "/secret/x.d.ts": "export declare const leaked = 1;\n",
        "/n/orc-evil/x.d.ts": "export declare const leaked2 = 1;\n",
      }),
    );
    const result = await collectPackageTypes(fs, { name: "orc", nodeModulesDirs: ["/n"] });
    const isOutside = (path: string) => path !== dir && !path.startsWith(`${dir}/`);
    expect(fs.isFileCalls.some(isOutside)).toBe(false);
    expect(fs.readTextCalls.some(isOutside)).toBe(false);
    expect(result.hasTypes).toBe(false);
    expect(result.typesPackage).toBe("@types/orc");
  });

  // N1: a package whose own declarations can't be loaded reports truncated and never offers or substitutes @types.
  test("a package whose own declarations can't be loaded reports truncated and never offers or substitutes @types", async () => {
    // (a) Own declarations over the byte cap; a valid @types package is also installed but must never be used.
    const overCap = memoryFs({
      "/n/lib/package.json": JSON.stringify({ name: "lib", types: "index.d.ts" }),
      "/n/lib/index.d.ts": "x".repeat(2000),
      "/n/@types/lib/package.json": JSON.stringify({ name: "@types/lib", types: "index.d.ts" }),
      "/n/@types/lib/index.d.ts": "export declare const v: 1;\n",
    });
    const overCapResult = await collectPackageTypes(overCap, { name: "lib", nodeModulesDirs: ["/n"], maxBytes: 1000 });
    expect(overCapResult.hasTypes).toBe(false);
    expect(overCapResult.typesPackage).toBeNull();
    expect(overCapResult.truncated).toBe(true);
    expect(overCapResult.files).toEqual([]);

    // (b) Own declaration gated out by a symlink escape; pins mutation M4 (see report).
    const gatedOut = memoryFs(
      {
        "/n/lib/package.json": JSON.stringify({ name: "lib", types: "index.d.ts" }),
        "/outside/x.d.ts": "export declare const leaked = 1;\n",
      },
      { "/n/lib/index.d.ts": "/outside/x.d.ts" },
    );
    const gatedResult = await collectPackageTypes(gatedOut, { name: "lib", nodeModulesDirs: ["/n"] });
    expect(gatedResult.hasTypes).toBe(false);
    expect(gatedResult.typesPackage).toBeNull();
    expect(gatedResult.truncated).toBe(true);

    // (c) The @types fallback itself is over the byte cap.
    const typesOverCap = memoryFs({
      "/n/lib2/package.json": JSON.stringify({ name: "lib2", main: "index.js" }),
      "/n/@types/lib2/package.json": JSON.stringify({ name: "@types/lib2", types: "index.d.ts" }),
      "/n/@types/lib2/index.d.ts": "y".repeat(2000),
    });
    const typesOverCapResult = await collectPackageTypes(typesOverCap, {
      name: "lib2",
      nodeModulesDirs: ["/n"],
      maxBytes: 1000,
    });
    expect(typesOverCapResult.hasTypes).toBe(false);
    expect(typesOverCapResult.typesPackage).toBe("@types/lib2");
    expect(typesOverCapResult.truncated).toBe(true);
  });

  // N2: the declared-entry cap counts only in-package entries, and reports when it drops some.
  test("the declared-entry cap counts only in-package entries and reports truncation", async () => {
    // (a) Over the cap: 100 distinct subpath entries, all resolvable, no index.
    const overCapFiles: Record<string, string> = {};
    const exportsField: Record<string, unknown> = {};
    for (let i = 0; i < 100; i++) {
      exportsField[`./s${i}`] = { types: `./s${i}.d.ts` };
      overCapFiles[`/n/lib/s${i}.d.ts`] = `export declare const v${i}: number;\n`;
    }
    overCapFiles["/n/lib/package.json"] = JSON.stringify({ name: "lib", exports: exportsField });
    const overCapResult = await collectPackageTypes(memoryFs(overCapFiles), { name: "lib", nodeModulesDirs: ["/n"] });
    expect(overCapResult.hasTypes).toBe(true);
    expect(overCapResult.files.length).toBe(MAX_DECLARED_TYPE_ENTRIES + 1); // + package.json
    expect(overCapResult.truncated).toBe(true);

    // (b) Entries pointing outside the package never use a cap slot, so a later in-package entry still resolves.
    const outsideExports: Record<string, unknown> = {};
    for (let i = 0; i < MAX_DECLARED_TYPE_ENTRIES; i++) outsideExports[`./o${i}`] = { types: `../o${i}.d.ts` };
    outsideExports["."] = { types: "./index.d.ts" };
    const outsideFs = memoryFs({
      "/n/lib2/package.json": JSON.stringify({ name: "lib2", exports: outsideExports }),
      "/n/lib2/index.d.ts": "export declare const v: 1;\n",
    });
    const outsideResult = await collectPackageTypes(outsideFs, { name: "lib2", nodeModulesDirs: ["/n"] });
    expect(outsideResult.hasTypes).toBe(true);
    expect(outsideResult.files.map((file) => file.path)).toContain("file:///node_modules/lib2/index.d.ts");
  });

  // N3: manifest-entry probes and the closure walk draw on one shared budget, not two separate ones.
  test("manifest-entry probes and the closure walk draw on one budget", async () => {
    const exportsField: Record<string, unknown> = {};
    for (let i = 0; i < 63; i++) exportsField[`./s${i}`] = { types: `./s${i}` }; // none of these exist
    exportsField["."] = { types: "./index.d.ts" };
    const lines: string[] = [];
    for (let i = 0; i < 40000; i++) lines.push(`export * from "./m${i}";`); // none of these exist either
    const fs = countingFs(
      memoryFs({
        "/n/lib/package.json": JSON.stringify({ name: "lib", exports: exportsField }),
        "/n/lib/index.d.ts": `${lines.join("\n")}\n`,
      }),
    );
    const result = await collectPackageTypes(fs, { name: "lib", nodeModulesDirs: ["/n"] });
    expect(fs.isFileCalls.length).toBeLessThanOrEqual(MAX_PACKAGE_TYPE_FILES * 16);
    expect(result.truncated).toBe(true);
    expect(result.hasTypes).toBe(true);
  });

  // N4: an entry that normalizes to the package directory itself must never probe `<node_modules>/<name>.d.{ts,mts,cts}`.
  test("entries that normalize to the package directory never probe sibling paths", async () => {
    const fs = countingFs(
      memoryFs({
        "/n/node_modules/lib/package.json": JSON.stringify({
          name: "lib",
          types: ".",
          exports: { ".": { types: "../lib" } },
        }),
        "/n/node_modules/lib/index.d.ts": "export declare const v: 1;\n",
        "/n/node_modules/lib.d.ts": "export declare const sibling: 1;\n",
        "/n/node_modules/lib.d.mts": "export declare const sibling: 1;\n",
      }),
    );
    const result = await collectPackageTypes(fs, { name: "lib", nodeModulesDirs: ["/n/node_modules"] });
    expect(result.hasTypes).toBe(true);
    expect(result.files.map((file) => file.path)).toContain("file:///node_modules/lib/index.d.ts");
    const forbidden = ["/n/node_modules/lib.d.ts", "/n/node_modules/lib.d.mts", "/n/node_modules/lib.d.cts"];
    expect(fs.isFileCalls.some((path) => forbidden.includes(path))).toBe(false);
    expect(fs.readTextCalls.some((path) => forbidden.includes(path))).toBe(false);
    expect(fs.realpathCalls.some((path) => forbidden.includes(path))).toBe(false);
  });
});

describe("working-directory local types (spec §6.2)", () => {
  test("resolves relative imports inside the WD, follows them, never leaves the WD and lists bare packages", async () => {
    const fs = memoryFs({
      "/wd/util.ts":
        'import { z } from "zod";\nexport { helper } from "./lib/helper.js";\nexport const User = z.object({});\n',
      "/wd/lib/helper.ts": 'import "../../outside/secret";\nexport const helper = 1;\n',
      "/outside/secret.ts": "export const secret = 1;\n",
      "/wd/types.d.ts": "export interface Shape { id: number }\n",
    });
    const result = await collectLocalTypes(fs, {
      workingDirectory: "/wd",
      specifiers: ["./util", "./types", "../outside/secret"],
    });
    expect(result.files.map((file) => file.path).sort()).toEqual([
      "file:///tab/lib/helper.ts",
      "file:///tab/types.d.ts",
      "file:///tab/util.ts",
    ]);
    expect(result.packages).toEqual(["zod"]);
    expect(result.truncated).toBe(false);
  });

  test("excludes a local file that is a symlink pointing outside the working directory", async () => {
    const fs = memoryFs(
      {
        "/wd/util.ts": 'export { helper } from "./linked";\nexport const a = 1;\n',
        "/outside/secret.ts": "export const secret = 1;\n",
      },
      { "/wd/linked.ts": "/outside/secret.ts" },
    );
    const result = await collectLocalTypes(fs, { workingDirectory: "/wd", specifiers: ["./util"] });
    expect(result.files.map((file) => file.path).sort()).toEqual(["file:///tab/util.ts"]);
  });

  // M-5: pins the separator-safe prefix check with a sibling directory whose name starts with the root name.
  test("a symlink to a sibling directory whose name starts with the root name is outside", async () => {
    const fs = memoryFs({ "/wd-evil/x.ts": "export const EVIL = 1;\n" }, { "/wd/x.ts": "/wd-evil/x.ts" });
    const result = await collectLocalTypes(fs, { workingDirectory: "/wd", specifiers: ["./x"] });
    expect(result.files).toEqual([]);
  });

  // M-1: a WD whose real path can't be resolved fails closed, even though a file exists under it lexically.
  test("local types return nothing when the working directory can't be resolved", async () => {
    const fs = memoryFs({ "/wd/util.ts": "export const a = 1;\n" }, {}, ["/wd"]);
    const result = await collectLocalTypes(fs, { workingDirectory: "/wd", specifiers: ["./util"] });
    expect(result).toEqual({ files: [], packages: [], truncated: false });
  });

  // M-3: two symlink aliases resolving to the same real file are returned once, and it's read once.
  test("two symlink aliases to the same file are returned once", async () => {
    const fs = countingFs(
      memoryFs(
        { "/wd/real.ts": "export const a = 1;\n" },
        { "/wd/alias1.ts": "/wd/real.ts", "/wd/alias2.ts": "/wd/real.ts" },
      ),
    );
    const result = await collectLocalTypes(fs, {
      workingDirectory: "/wd",
      specifiers: ["./alias1", "./alias2", "./real"],
    });
    expect(result.files).toEqual([{ path: "file:///tab/alias1.ts", content: "export const a = 1;\n" }]);
    expect(fs.readTextCalls.filter((path) => path === "/wd/real.ts").length).toBe(1);
  });

  // I-1: a file with far more missing relative specifiers than the probe budget stays bounded and truncates.
  test("missing relative specifiers stop at the probe budget and report truncated", async () => {
    const missingCount = MAX_LOCAL_TYPE_FILES * 16 + 50;
    const lines: string[] = [];
    for (let i = 0; i < missingCount; i++) lines.push(`import "./missing${i}";`);
    const fs = countingFs(memoryFs({ "/wd/a.ts": `${lines.join("\n")}\n` }));
    const result = await collectLocalTypes(fs, { workingDirectory: "/wd", specifiers: ["./a"] });
    expect(result.truncated).toBe(true);
    expect(fs.isFileCalls.length).toBeLessThanOrEqual(MAX_LOCAL_TYPE_FILES * 16 + 20);
  });

  // #4: a relative working directory would otherwise resolve against Main's cwd; it must be rejected instead.
  // N6: the guard must run before any fs call at all, not just before readText.
  test("a relative working directory returns nothing", async () => {
    const fs = countingFs(memoryFs({ "cwdwd/util.ts": "export const a = 1;\n" }));
    const result = await collectLocalTypes(fs, { workingDirectory: "cwdwd", specifiers: ["./util"] });
    expect(result).toEqual({ files: [], packages: [], truncated: false });
    expect(fs.readTextCalls).toEqual([]);
    expect(fs.isFileCalls).toEqual([]);
    expect(fs.realpathCalls).toEqual([]);
  });

  // #5: exhausting the probe budget must not discard files already found, or the current file's bare dependencies.
  test("budget exhaustion keeps files and dependencies already found", async () => {
    const missingCount = 400;
    const lines: string[] = ['import "./a";'];
    for (let i = 0; i < missingCount; i++) lines.push(`import "./missing${i}";`);
    lines.push('import "dep-ok";');
    const fs = countingFs(
      memoryFs({
        "/wd/root.ts": `${lines.join("\n")}\n`,
        "/wd/a.ts": "export const a = 1;\n",
      }),
    );
    const result = await collectLocalTypes(fs, { workingDirectory: "/wd", specifiers: ["./root"] });
    expect(result.files.some((file) => file.path === "file:///tab/a.ts")).toBe(true);
    expect(result.packages).toContain("dep-ok");
    expect(result.truncated).toBe(true);
  });
});
