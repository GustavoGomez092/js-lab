import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transform } from "../src/transform";
import { baseOptions, runInstrumented } from "./helpers";

const NL = String.fromCharCode(10);
const wd = { dir: "/work/api", filename: "/work/api/fetch users.ts" };
const code = (source: string, withWd = true) => {
  const result = transform(source, {
    ...baseOptions,
    autoLog: false,
    loopProtection: false,
    ...(withWd ? { workingDirectory: wd } : {}),
  });
  if (!result.ok) throw new Error(result.diagnostics[0]?.message);
  return result.code;
};

let dir = "";
beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "jslab-wd-transform-")));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("working directory transform (spec §5.3)", () => {
  test("rewrites relative specifiers against the WD and leaves bare, absolute and computed ones", () => {
    const out = code(
      [
        'import a from "./a";',
        'export { b } from "../lib/b.js";',
        'export * from "./c";',
        'const d = await import("./d");',
        'const e = require("./e");',
        'const p = require.resolve("./p");',
        'import z from "zod";',
        'import abs from "/abs/x";',
        'const name = "./computed"; await import(name);',
        // The TypeScript preset elides unused value imports, so the fixture uses every imported binding.
        "console.log(a, z, abs);",
      ].join(NL),
    );
    for (const path of ["/work/api/a", "/work/lib/b.js", "/work/api/c", "/work/api/d", "/work/api/e", "/work/api/p"]) {
      expect(out).toContain(`"${path}"`);
    }
    expect(out).toContain('"zod"');
    expect(out).toContain('"/abs/x"');
    expect(out).toContain('"./computed"');
  });

  test("replaces free __dirname and __filename, but not shadowed bindings or assignment targets", () => {
    const out = code(
      "const where = [__dirname, __filename];" +
        NL +
        "function f(__dirname: string) { return __dirname; }" +
        NL +
        "let __filename2 = 1;" +
        NL,
    );
    expect(out).toContain('["/work/api", "/work/api/fetch users.ts"]');
    expect(out).toContain("return __dirname;");
  });

  test("replaces import.meta.dir, path, url and module.filename/path", () => {
    const out = code(
      "const m = [import.meta.dir, import.meta.dirname, import.meta.path, import.meta.filename, import.meta.url, module.filename, module.path];",
    );
    expect(out).toContain(
      '["/work/api", "/work/api", "/work/api/fetch users.ts", "/work/api/fetch users.ts", "file:///work/api/fetch%20users.ts", "/work/api/fetch users.ts", "/work/api"]',
    );
  });

  test("without a working directory nothing is rewritten", () => {
    // `a` is used so the TypeScript preset keeps the import.
    const out = code(`import a from "./a";${NL}const x = [a, __dirname];`, false);
    expect(out).toContain('"./a"');
    expect(out).toContain("__dirname");
  });

  test("a relative import from the WD runs and __filename reports the tab's script path", async () => {
    await writeFile(join(dir, "util.mjs"), `export const value = 41;${NL}`);
    const { calls } = await runInstrumented(`import { value } from "./util.mjs";${NL}[value + 1, __filename]`, {
      workingDirectory: { dir, filename: join(dir, "scratch.ts") },
    });
    expect(calls.at(-1)?.value).toEqual([42, join(dir, "scratch.ts")]);
  });
});
