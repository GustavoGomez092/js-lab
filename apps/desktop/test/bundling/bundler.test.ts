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

  // Fix round 1, M1: `locateImport`'s blocked-builtin position must find the real import, not an earlier
  // coincidental match of the same quoted text in a comment or an unrelated string literal.
  test("the blocked-builtin code frame points at the real import, not an earlier comment mentioning the same quoted text", async () => {
    await writeFile(
      join(workingDirectory, "entry.js"),
      '// see "fs" module docs for details\nimport fs from "fs";\nglobalThis.fs = fs;\n',
    );

    const result = await bundleForWeb({
      entry: join(workingDirectory, "entry.js"),
      runtime: "browser",
      workingDirectory,
      packagesNodeModules,
    });

    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.error.specifier).toBe("fs");
    expect(result.error.line).toBe(2);
    expect(result.error.codeFrame).toContain('import fs from "fs";');
  });

  test("the blocked-builtin code frame points at the real import, not an earlier unrelated string literal with the same quoted text", async () => {
    await writeFile(
      join(workingDirectory, "entry.js"),
      'const label = "fs";\nimport fs from "fs";\nglobalThis.fs = fs;\n',
    );

    const result = await bundleForWeb({
      entry: join(workingDirectory, "entry.js"),
      runtime: "browser",
      workingDirectory,
      packagesNodeModules,
    });

    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.error.specifier).toBe("fs");
    expect(result.error.line).toBe(2);
    expect(result.error.codeFrame).toContain('import fs from "fs";');
  });
});

/**
 * Fix round 1, C1: a bare specifier `jslabResolve` can't resolve in either intended directory must never reach
 * Bun's own default resolver, which does a Node-style upward `node_modules` walk -- exactly what
 * `resolveBareSpecifier`'s containment check exists to defeat. These fixtures put a real, populated `node_modules`
 * *above* a nested working directory (an ordinary monorepo-style layout) to make that ancestor path actually
 * reachable, which the flat `root/wd` + `root/pkgs/node_modules` layout above structurally cannot exercise.
 */
describe("bundleForWeb resolve leak (fix round 1, C1)", () => {
  let ancestorRoot = "";
  let ancestorNodeModules = "";
  let nestedWorkingDirectory = "";
  let nestedPackagesNodeModules = "";

  beforeEach(async () => {
    ancestorRoot = await mkdtemp(join(tmpdir(), "jslab-bundler-leak-"));
    ancestorNodeModules = join(ancestorRoot, "node_modules");
    nestedWorkingDirectory = join(ancestorRoot, "nested", "wd");
    nestedPackagesNodeModules = join(ancestorRoot, "pkgs", "node_modules");
    await mkdir(ancestorNodeModules, { recursive: true });
    await mkdir(nestedWorkingDirectory, { recursive: true });
    await mkdir(nestedPackagesNodeModules, { recursive: true });
  });

  afterEach(async () => {
    await rm(ancestorRoot, { recursive: true, force: true });
  });

  test("a package reachable only through an unrelated ancestor node_modules is rejected, not silently bundled", async () => {
    await writePackage(ancestorNodeModules, "evil-pkg", "globalThis.__p = 'evil';\nexport default 'evil';");
    await writeFile(join(nestedWorkingDirectory, "entry.js"), "import x from 'evil-pkg';\nglobalThis.__jlProbe = x;\n");

    const result = await bundleForWeb({
      entry: join(nestedWorkingDirectory, "entry.js"),
      runtime: "browser",
      workingDirectory: nestedWorkingDirectory,
      packagesNodeModules: nestedPackagesNodeModules,
    });

    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.error.specifier).toBe("evil-pkg");
    expect("imports" in result).toBe(false);
  });

  test("a package in the working directory's own node_modules still resolves when a different version is reachable through an ancestor", async () => {
    await writePackage(ancestorNodeModules, "left-pad", "export default 'from-ancestor';");
    await writePackage(join(nestedWorkingDirectory, "node_modules"), "left-pad", "export default 'from-wd';");
    await writeFile(
      join(nestedWorkingDirectory, "entry.js"),
      "import lp from 'left-pad';\nglobalThis.__jlProbe = lp;\n",
    );

    const result = await bundleForWeb({
      entry: join(nestedWorkingDirectory, "entry.js"),
      runtime: "browser",
      workingDirectory: nestedWorkingDirectory,
      packagesNodeModules: nestedPackagesNodeModules,
    });

    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.code).not.toContain("from-ancestor");

    const g: Record<string, unknown> = {};
    new Function("globalThis", result.code)(g);
    expect(g.__jlProbe).toBe("from-wd");
  });

  test("imports lists exactly the packages actually bundled, one from the working directory and one from the packages folder", async () => {
    await writePackage(ancestorNodeModules, "unused-ancestor-pkg", "export default 'unused';");
    await writePackage(join(nestedWorkingDirectory, "node_modules"), "wd-only-pkg", "export default 'from-wd';");
    await writePackage(nestedPackagesNodeModules, "packages-only-pkg", "export default 'from-pkgs';");
    await writeFile(
      join(nestedWorkingDirectory, "entry.js"),
      "import a from 'wd-only-pkg';\nimport b from 'packages-only-pkg';\nglobalThis.__jlProbe = [a, b];\n",
    );

    const result = await bundleForWeb({
      entry: join(nestedWorkingDirectory, "entry.js"),
      runtime: "browser",
      workingDirectory: nestedWorkingDirectory,
      packagesNodeModules: nestedPackagesNodeModules,
    });

    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect([...result.imports].sort()).toEqual(["packages-only-pkg", "wd-only-pkg"]);
  });
});
