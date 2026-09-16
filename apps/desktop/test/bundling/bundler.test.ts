import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundleForWeb } from "../../src/main/bundling/bundler";

let root = "";
let workingDirectory = "";
let packagesNodeModules = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "jslab-bundler-"));
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

/** Runs bundled code (no leftover `import`/`export`, since everything got inlined) with a minimal DOM stub. */
function runBundle(code: string) {
  const appended: Array<{ textContent?: string }> = [];
  const document = {
    head: { appendChild: (el: { textContent?: string }) => appended.push(el) },
    createElement: () => ({ textContent: "" }) as { textContent?: string },
  };
  new Function("document", code)(document);
  return { appended, document };
}

describe("bundleForWeb", () => {
  test("bundles a two-module fixture from a temp dir into code that runs under new Function", async () => {
    await writeFile(join(workingDirectory, "helper.js"), "export function greet(name) { return 'hello ' + name; }\n");
    await writeFile(
      join(workingDirectory, "entry.js"),
      "import { greet } from './helper.js';\nglobalThis.__jlProbe = greet('world');\n",
    );

    const result = await bundleForWeb({
      entry: join(workingDirectory, "entry.js"),
      runtime: "browser",
      workingDirectory,
      packagesNodeModules,
    });

    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.code.length).toBeGreaterThan(0);
    expect(result.map.length).toBeGreaterThan(0);
    expect(result.imports).toEqual([]);

    const g: Record<string, unknown> = {};
    new Function("globalThis", result.code)(g);
    expect(g.__jlProbe).toBe("hello world");
  });

  test("resolves an npm package from the working directory ahead of the packages folder and records it in imports", async () => {
    await writePackage(join(workingDirectory, "node_modules"), "left-pad", "export default 'from-wd';");
    await writePackage(packagesNodeModules, "left-pad", "export default 'from-pkgs';");
    await writeFile(join(workingDirectory, "entry.js"), "import lp from 'left-pad';\nglobalThis.__jlProbe = lp;\n");

    const result = await bundleForWeb({
      entry: join(workingDirectory, "entry.js"),
      runtime: "browser",
      workingDirectory,
      packagesNodeModules,
    });

    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.imports).toEqual(["left-pad"]);

    const g: Record<string, unknown> = {};
    new Function("globalThis", result.code)(g);
    expect(g.__jlProbe).toBe("from-wd");
  });

  test("reports a missing bare import as a BundleError carrying the specifier, line and column", async () => {
    await writeFile(join(workingDirectory, "entry.js"), "import x from 'totally-missing-pkg';\nglobalThis.x = x;\n");

    const result = await bundleForWeb({
      entry: join(workingDirectory, "entry.js"),
      runtime: "browser",
      workingDirectory,
      packagesNodeModules,
    });

    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.error.specifier).toBe("totally-missing-pkg");
    expect(result.error.line).toBe(1);
    expect(typeof result.error.column).toBe("number");
    expect(result.error.message.length).toBeGreaterThan(0);
  });

  test("injects an imported stylesheet as a runtime <style> append", async () => {
    await writeFile(join(workingDirectory, "styles.css"), "body { color: teal; }");
    await writeFile(join(workingDirectory, "entry.js"), "import './styles.css';\n");

    const result = await bundleForWeb({
      entry: join(workingDirectory, "entry.js"),
      runtime: "browser",
      workingDirectory,
      packagesNodeModules,
    });

    expect("error" in result).toBe(false);
    if ("error" in result) return;
    const { appended } = runBundle(result.code);
    expect(appended).toHaveLength(1);
    expect(appended[0]?.textContent).toBe("body { color: teal; }");
  });

  test("blocks a Node builtin import under the browser runtime with an install-assist-shaped error", async () => {
    await writeFile(join(workingDirectory, "entry.js"), "import fs from 'fs';\nglobalThis.fs = fs;\n");

    const result = await bundleForWeb({
      entry: join(workingDirectory, "entry.js"),
      runtime: "browser",
      workingDirectory,
      packagesNodeModules,
    });

    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.error.specifier).toBe("fs");
    expect(result.error.codeFrame).toContain("fs");
  });
});
