import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const ENTRY = join(import.meta.dir, "..", "src", "web-entry.ts");

/**
 * Main delivers the web runner by handing this bundle's *text* to a page's `executeJavascript`, which evaluates it
 * as a classic script -- not as a module. So the bundle must contain no module syntax at all: a single top-level
 * `import` or `export` is a parse error that kills the whole injection, and the only symptom Main would ever see
 * is a page that never reports `ready`, i.e. a run that hangs until `waitForReady` gives up.
 *
 * Nothing in the build command enforces this any more. The obvious flag (`--format iife`) cannot be used: the
 * bundles are built inside Hutch's Cottontail shell, whose `build` command rejects `--format` outright. The
 * default browser output happens to be self-contained -- so this test pins that property on the emitted bytes,
 * where a future dependency pulling in a stray re-export would show up.
 */
describe("the injectable web bootstrap bundle", () => {
  test("is a classic script: no top-level module syntax, and it parses as one", async () => {
    const built = await Bun.build({ entrypoints: [ENTRY], target: "browser" });
    expect(built.success).toBe(true);

    const output = built.outputs[0];
    expect(output).toBeDefined();
    const code = await (output as NonNullable<typeof output>).text();

    expect(code).not.toMatch(/^\s*(?:import|export)[\s{*]/m);
    expect(code).not.toContain("import.meta");
    // The decisive check: `new Function` compiles its body under classic-script rules, so any module syntax that
    // slipped past the patterns above throws here rather than in a webview nobody is watching.
    expect(() => new Function(code)).not.toThrow();
  });

  test("actually starts the runner, rather than only defining it", async () => {
    const built = await Bun.build({ entrypoints: [ENTRY], target: "browser" });
    const output = built.outputs[0];
    const code = await (output as NonNullable<typeof output>).text();
    // `bootstrap.ts` exports `startRunnerWeb` without calling it (so tests can drive it against a fake global);
    // this entry exists precisely to call it, and a bundle that merely defined it would load silently and never
    // send `ready`.
    expect(code).toContain("__jslabHostMessage");
  });
});
