import { describe, expect, test } from "bun:test";
import { collectLocalTypes, collectPackageTypes, MAX_PACKAGE_TYPE_FILES, type TypesFs } from "../src/type-closure";

function memoryFs(files: Record<string, string>, links: Record<string, string> = {}): TypesFs {
  return {
    readText: async (path) => files[path] ?? (path in links ? (files[links[path] as string] ?? null) : null),
    isFile: async (path) => path in files || path in links,
    realpath: async (path) => links[path] ?? (path in files ? path : null),
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
});
