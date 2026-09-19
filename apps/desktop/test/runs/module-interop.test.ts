import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createRunHarness, NL, type RunHarness } from "./run-harness";

/**
 * EX-19 (spec §5.3): "ES modules and CommonJS, `node:` specifiers" -- real ESM, with `require` available.
 *
 * The parity row was 🚧 with "CJS `require`/`node:` interop not yet covered by a test". What existed covered
 * neither half of the claim: `packages/transform`'s `working-directory.test.ts` asserts only that a `require(...)`
 * *call site is rewritten* to resolve against the working directory (a source-to-source assertion -- nothing is
 * ever required), and `runner-environment.test.ts` uses `require("node:fs")` inside a **preload** script, which is
 * loaded by Bun itself and says nothing about what a user's run can do. The one genuine run-level `node:` case,
 * `apps/desktop/test/runs/working-directory.test.ts`'s `import { readFileSync } from "node:fs"`, covers the ESM
 * import form only -- so `require` was untested end to end in every spelling.
 *
 * These run through a real runner process, because the claim is about the runtime the entry is evaluated in: the
 * entry is written as `.mjs`, where Node would give no `require` at all. That `require` exists here is a property
 * of Bun, and only executing it can establish it.
 */

let h: RunHarness | null = null;

afterEach(async () => {
  await h?.dispose();
  h = null;
});

const TERMINAL = ["idle", "settled", "failed"] as const;

/** Writes a CommonJS module (stateful, so a second `require` of it is distinguishable from a first). */
async function writeCjsModule(dir: string): Promise<string> {
  const path = join(dir, "legacy.cjs");
  await Bun.write(path, ["let calls = 0;", 'module.exports = { name: "cjs", bump: () => ++calls };', ""].join(NL));
  return path;
}

describe("ESM / CommonJS / node: interop (EX-19, spec §5.3) -- Bun runtime", () => {
  test("require() loads a CommonJS module, and its exports behave like CJS exports", async () => {
    h = await createRunHarness();
    const cjs = JSON.stringify(await writeCjsModule(h.dir));
    const { runId } = h.start(
      [
        `const legacy = require(${cjs});`,
        "console.log(JSON.stringify({ name: legacy.name, first: legacy.bump(), second: legacy.bump() }));",
      ].join(NL),
    );
    await h.waitFor(runId, [...TERMINAL]);
    expect(h.errorsFor(runId)).toEqual([]);
    // `module.exports` came back as the object itself (not wrapped in a `default`), and it is one live instance.
    expect(JSON.parse(h.consoleTextFor(runId)[0] ?? "{}")).toEqual({ name: "cjs", first: 1, second: 2 });
  }, 30_000);

  test("require() resolves a node: builtin and its bare spelling to the same module", async () => {
    h = await createRunHarness();
    const { runId } = h.start(
      [
        'const prefixed = require("node:os");',
        'const bare = require("os");',
        "console.log(JSON.stringify({",
        "  prefixed: typeof prefixed.platform, bare: typeof bare.platform, same: prefixed === bare,",
        "}));",
      ].join(NL),
    );
    await h.waitFor(runId, [...TERMINAL]);
    expect(h.errorsFor(runId)).toEqual([]);
    // `same` is the discriminating half: both spellings must reach one module, not two lookalike shims.
    expect(JSON.parse(h.consoleTextFor(runId)[0] ?? "{}")).toEqual({
      prefixed: "function",
      bare: "function",
      same: true,
    });
  }, 30_000);

  test("ESM import syntax and require() work in the same module", async () => {
    h = await createRunHarness();
    const cjs = JSON.stringify(await writeCjsModule(h.dir));
    const { runId } = h.start(
      [
        // Static ESM import: this is what makes the file real ESM rather than CJS that merely parses.
        'import { join as joinPath } from "node:path";',
        `const legacy = require(${cjs});`,
        "console.log(JSON.stringify({",
        '  esm: joinPath("a", "b"), cjs: legacy.name, requireType: typeof require,',
        `  resolves: require.resolve(${cjs}) === ${cjs},`,
        "}));",
      ].join(NL),
    );
    await h.waitFor(runId, [...TERMINAL]);
    expect(h.errorsFor(runId)).toEqual([]);
    expect(JSON.parse(h.consoleTextFor(runId)[0] ?? "{}")).toEqual({
      esm: "a/b",
      cjs: "cjs",
      requireType: "function",
      resolves: true,
    });
  }, 30_000);
});
