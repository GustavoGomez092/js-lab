import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundleAppForWeb, bundleVendorForWeb, joinVendorAndApp } from "../../src/main/bundling/bundler";

let root = "";
let workingDirectory = "";
let packagesNodeModules = "";
/** The app's data directory (Task 9f item 5). Unread by these `browser`-runtime builds, which have no `process`
 * snapshot at all, but `BundleOptions` requires it deliberately -- see that field's own note. */
let dataDir = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "jslab-bundler-"));
  workingDirectory = join(root, "wd");
  packagesNodeModules = join(root, "pkgs", "node_modules");
  dataDir = join(root, "data");
  await mkdir(workingDirectory, { recursive: true });
  await mkdir(packagesNodeModules, { recursive: true });
  await mkdir(dataDir, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writePackage(nodeModulesDir: string, name: string, contents: string, pkgJson: object = {}) {
  const pkgDir = join(nodeModulesDir, name);
  await mkdir(pkgDir, { recursive: true });
  await writeFile(join(pkgDir, "package.json"), JSON.stringify({ name, main: "index.js", ...pkgJson }));
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

let joinedRunCounter = 0;

/**
 * Evaluates a joined bundle the way the page does -- as one real ES module -- and returns whatever it left on
 * `globalThis.__jlProbe`. A joined bundle has a top-level `await` in it (the vendor prelude), so `new Function`
 * can't run one: it has to be a genuine module, which means a file and a dynamic `import()`. Each call gets its
 * own file name so the module cache never serves a previous call's copy.
 *
 * **The subdirectory is load-bearing under Bun 1.4.0**, which caches the directory listing of any directory
 * `Bun.build` walked while resolving: a file created there afterwards becomes invisible to the module resolver,
 * and `import()` reports `Cannot find module '<path>' from ''` for a file that `existsSync` confirms exists.
 * Resolving a package out of `packagesNodeModules` walks **up** through `root`, so `root` is exactly the poisoned
 * directory here. Measured: a sibling subdirectory of a walked directory is unaffected (the cache is per-directory,
 * not per-tree), and the module's contents are irrelevant. Bun 1.3.13 does not do this -- which is how the sibling
 * `polyfill-plugin.test.ts` passed locally and failed on CI, where the runner is 1.4.0.
 */
async function runJoinedModule(joined: string): Promise<unknown> {
  const dir = join(root, "joined");
  await mkdir(dir, { recursive: true });
  const file = join(dir, `joined-${joinedRunCounter++}.mjs`);
  await writeFile(file, joined);
  const g = globalThis as unknown as Record<string, unknown>;
  g.__jlProbe = undefined;
  await import(file);
  return g.__jlProbe;
}

/** The whole production path for one run: build the app chunk, build the vendor chunk it named, join them. */
async function bundleAndJoin(entry: string): Promise<string> {
  const app = await bundleAppForWeb({ entry, runtime: "browser", workingDirectory, packagesNodeModules, dataDir });
  if ("error" in app) throw new Error(`app build failed: ${app.error.message}`);
  if (app.imports.length === 0) return joinVendorAndApp(null, app.code);
  const vendor = await bundleVendorForWeb({
    imports: app.imports,
    runtime: "browser",
    workingDirectory,
    packagesNodeModules,
    dataDir,
  });
  if ("error" in vendor) throw new Error(`vendor build failed: ${vendor.error.message}`);
  return joinVendorAndApp(vendor.code, app.code);
}

describe("bundleAppForWeb", () => {
  test("bundles a two-module fixture from a temp dir into code that runs under new Function", async () => {
    await writeFile(join(workingDirectory, "helper.js"), "export function greet(name) { return 'hello ' + name; }\n");
    await writeFile(
      join(workingDirectory, "entry.js"),
      "import { greet } from './helper.js';\nglobalThis.__jlProbe = greet('world');\n",
    );

    const result = await bundleAppForWeb({
      entry: join(workingDirectory, "entry.js"),
      runtime: "browser",
      workingDirectory,
      packagesNodeModules,
      dataDir,
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

    const result = await bundleAppForWeb({
      entry: join(workingDirectory, "entry.js"),
      runtime: "browser",
      workingDirectory,
      packagesNodeModules,
      dataDir,
    });

    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.imports).toEqual(["left-pad"]);

    expect(await runJoinedModule(await bundleAndJoin(join(workingDirectory, "entry.js")))).toBe("from-wd");
  });

  test("reports a missing bare import as a BundleError carrying the specifier, line and column", async () => {
    await writeFile(join(workingDirectory, "entry.js"), "import x from 'totally-missing-pkg';\nglobalThis.x = x;\n");

    const result = await bundleAppForWeb({
      entry: join(workingDirectory, "entry.js"),
      runtime: "browser",
      workingDirectory,
      packagesNodeModules,
      dataDir,
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

    const result = await bundleAppForWeb({
      entry: join(workingDirectory, "entry.js"),
      runtime: "browser",
      workingDirectory,
      packagesNodeModules,
      dataDir,
    });

    expect("error" in result).toBe(false);
    if ("error" in result) return;
    const { appended } = runBundle(result.code);
    expect(appended).toHaveLength(1);
    expect(appended[0]?.textContent).toBe("body { color: teal; }");
  });

  test("blocks a Node builtin import under the browser runtime with an install-assist-shaped error", async () => {
    await writeFile(join(workingDirectory, "entry.js"), "import fs from 'fs';\nglobalThis.fs = fs;\n");

    const result = await bundleAppForWeb({
      entry: join(workingDirectory, "entry.js"),
      runtime: "browser",
      workingDirectory,
      packagesNodeModules,
      dataDir,
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

    const result = await bundleAppForWeb({
      entry: join(workingDirectory, "entry.js"),
      runtime: "browser",
      workingDirectory,
      packagesNodeModules,
      dataDir,
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

    const result = await bundleAppForWeb({
      entry: join(workingDirectory, "entry.js"),
      runtime: "browser",
      workingDirectory,
      packagesNodeModules,
      dataDir,
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
describe("bundleAppForWeb resolve leak (fix round 1, C1)", () => {
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

    const result = await bundleAppForWeb({
      entry: join(nestedWorkingDirectory, "entry.js"),
      runtime: "browser",
      workingDirectory: nestedWorkingDirectory,
      packagesNodeModules: nestedPackagesNodeModules,
      dataDir,
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

    const app = await bundleAppForWeb({
      entry: join(nestedWorkingDirectory, "entry.js"),
      runtime: "browser",
      workingDirectory: nestedWorkingDirectory,
      packagesNodeModules: nestedPackagesNodeModules,
      dataDir,
    });
    expect("error" in app).toBe(false);
    if ("error" in app) return;
    const vendor = await bundleVendorForWeb({
      imports: app.imports,
      runtime: "browser",
      workingDirectory: nestedWorkingDirectory,
      packagesNodeModules: nestedPackagesNodeModules,
      dataDir,
    });
    expect("error" in vendor).toBe(false);
    if ("error" in vendor) return;
    expect(vendor.code).not.toContain("from-ancestor");

    const file = join(ancestorRoot, "joined-leak.mjs");
    await writeFile(file, joinVendorAndApp(vendor.code, app.code));
    const g = globalThis as unknown as Record<string, unknown>;
    g.__jlProbe = undefined;
    await import(file);
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

    const result = await bundleAppForWeb({
      entry: join(nestedWorkingDirectory, "entry.js"),
      runtime: "browser",
      workingDirectory: nestedWorkingDirectory,
      packagesNodeModules: nestedPackagesNodeModules,
      dataDir,
    });

    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect([...result.imports].sort()).toEqual(["packages-only-pkg", "wd-only-pkg"]);
  });
});

/**
 * Task 8a: the vendor/app split. The app chunk carries only the tab's own code and a stub per package; the vendor
 * chunk carries the third-party code and publishes each package into one page-global registry. Joining the two
 * reproduces what a single unsplit build used to produce -- these tests pin that equivalence for every import form
 * (default, named, namespace) against both a CommonJS and an ES-module package, because the interop between them
 * is the one thing a split can silently get wrong.
 */
describe("the vendor/app split", () => {
  async function writeFixturePackages() {
    await writePackage(
      packagesNodeModules,
      "cjs-pkg",
      'module.exports = { tag: "cjs-default", named: "cjs-named" };\n',
    );
    await writePackage(
      packagesNodeModules,
      "esm-pkg",
      'export default { tag: "esm-default" };\nexport const named = "esm-named";\n',
      { type: "module" },
    );
  }

  test("the app chunk contains no package code and names the packages the vendor chunk must supply", async () => {
    await writeFixturePackages();
    await writeFile(join(workingDirectory, "entry.js"), "import c from 'cjs-pkg';\nglobalThis.__jlProbe = c.tag;\n");

    const app = await bundleAppForWeb({
      entry: join(workingDirectory, "entry.js"),
      runtime: "browser",
      workingDirectory,
      packagesNodeModules,
      dataDir,
    });

    expect("error" in app).toBe(false);
    if ("error" in app) return;
    expect(app.imports).toEqual(["cjs-pkg"]);
    // The package's own source text is the thing that must NOT be there -- that is what the vendor chunk carries.
    expect(app.code).not.toContain("cjs-default");
  });

  test("a joined bundle reproduces default, named and namespace imports for both a CommonJS and an ES-module package", async () => {
    await writeFixturePackages();
    await writeFile(
      join(workingDirectory, "entry.js"),
      [
        "import c from 'cjs-pkg';",
        "import { named as cNamed } from 'cjs-pkg';",
        "import * as cNs from 'cjs-pkg';",
        "import e from 'esm-pkg';",
        "import { named as eNamed } from 'esm-pkg';",
        "import * as eNs from 'esm-pkg';",
        "globalThis.__jlProbe = {",
        "  cTag: c.tag, cNamed, cNsDefaultTag: cNs.default.tag, cNsNamed: cNs.named,",
        "  eTag: e.tag, eNamed, eNsDefaultTag: eNs.default.tag, eNsNamed: eNs.named,",
        "  cNsKeys: Object.keys(cNs).sort(), eNsKeys: Object.keys(eNs).sort(),",
        "};",
      ].join("\n"),
    );

    const probe = (await runJoinedModule(await bundleAndJoin(join(workingDirectory, "entry.js")))) as Record<
      string,
      unknown
    >;

    expect(probe).toMatchObject({
      cTag: "cjs-default",
      cNamed: "cjs-named",
      cNsDefaultTag: "cjs-default",
      cNsNamed: "cjs-named",
      eTag: "esm-default",
      eNamed: "esm-named",
      eNsDefaultTag: "esm-default",
      eNsNamed: "esm-named",
    });

    // Fix round 1 (M1): the enumeration behaviour, pinned rather than merely described.
    // CommonJS is exact -- an unsplit build produces these same three keys, because the interop hands back
    // `module.exports` itself and nothing is proxied.
    expect(probe.cNsKeys).toEqual(["default", "named", "tag"]);
    // The one measured divergence. An unsplit build gives `["default", "named"]` here; the split adds `"tag"`,
    // the default export's own key, because an ES module with named exports absent from its default is served
    // through a proxy that has to keep the default's keys reachable. Values are identical either way (asserted
    // above); only enumeration differs. If this ever widens further, this assertion is what catches it.
    expect(probe.eNsKeys).toEqual(["default", "named", "tag"]);
  });

  // Fix round 1 (C1). The app build resolves only the tab's DIRECT imports, so it cannot see this: a package from
  // the shared folder whose own dependency resolves out of the working directory (the resolver tries the working
  // directory first, in every build). The chunk is then full of working-directory code that `bun.lock` -- half the
  // cache key -- knows nothing about. Only the vendor build can report it, so it must.
  test("a dependency reached through another package, resolved from the working directory, makes the vendor chunk unkeyable", async () => {
    await writePackage(
      packagesNodeModules,
      "shared-pkg",
      "import dep from 'transitive-dep';\nexport default 'shared:' + dep;\n",
    );
    await writePackage(packagesNodeModules, "transitive-dep", "export default 'from-shared-folder';");
    await writePackage(join(workingDirectory, "node_modules"), "transitive-dep", "export default 'from-wd';");
    await writeFile(join(workingDirectory, "entry.js"), "import s from 'shared-pkg';\nglobalThis.__jlProbe = s;\n");

    const app = await bundleAppForWeb({
      entry: join(workingDirectory, "entry.js"),
      runtime: "browser",
      workingDirectory,
      packagesNodeModules,
      dataDir,
    });
    expect("error" in app).toBe(false);
    if ("error" in app) return;
    // The direct import really did come from the shared folder, so the app build has no objection of its own.
    expect(app.imports).toEqual(["shared-pkg"]);
    expect(app.vendorCacheable).toBe(true);

    const vendor = await bundleVendorForWeb({
      imports: app.imports,
      runtime: "browser",
      workingDirectory,
      packagesNodeModules,
      dataDir,
    });
    expect("error" in vendor).toBe(false);
    if ("error" in vendor) return;
    // The chunk genuinely contains the working-directory copy...
    expect(vendor.code).toContain("from-wd");
    expect(vendor.code).not.toContain("from-shared-folder");
    // ...so it must not be storable under a key that cannot describe it.
    expect(vendor.vendorCacheable).toBe(false);
  });

  // Fix round 1 (I1): the vendor chunk owns the registry outright. Today the page reloads before every run so
  // there is never anything to inherit, but the chunk must not depend on that happening two files away.
  test("the vendor chunk replaces a registry left behind by an earlier run rather than adopting it", async () => {
    await writeFixturePackages();
    await writeFile(
      join(workingDirectory, "entry.js"),
      [
        "import c from 'cjs-pkg';",
        "globalThis.__jlProbe = { stale: globalThis.__jslabVendor['stale-pkg'], tag: c.tag };",
      ].join("\n"),
    );
    const g = globalThis as unknown as Record<string, unknown>;
    g.__jslabVendor = { "stale-pkg": "A PREVIOUS RUN'S MODULE" };
    try {
      const probe = (await runJoinedModule(await bundleAndJoin(join(workingDirectory, "entry.js")))) as Record<
        string,
        unknown
      >;
      expect(probe.stale).toBeUndefined();
      expect(probe.tag).toBe("cjs-default");
    } finally {
      delete g.__jslabVendor;
    }
  });

  // The whole point of the split: this is the vendor chunk a cache hit would serve. Reusing a *previous* run's
  // vendor chunk with a *newly built* app chunk must run the new app code -- if the app chunk were ever reused
  // along with it, this would still report the old value and the cache would be serving stale code.
  test("a vendor chunk built for an earlier run joins with a freshly built app chunk and runs the new code", async () => {
    await writeFixturePackages();
    const entry = join(workingDirectory, "entry.js");
    await writeFile(entry, "import c from 'cjs-pkg';\nglobalThis.__jlProbe = c.tag + ':first';\n");
    const first = await bundleAppForWeb({ entry, runtime: "browser", workingDirectory, packagesNodeModules, dataDir });
    expect("error" in first).toBe(false);
    if ("error" in first) return;
    const vendor = await bundleVendorForWeb({
      imports: first.imports,
      runtime: "browser",
      workingDirectory,
      packagesNodeModules,
      dataDir,
    });
    expect("error" in vendor).toBe(false);
    if ("error" in vendor) return;

    // The user edits their code; the imports are unchanged, so the same vendor chunk is still the right one.
    await writeFile(entry, "import c from 'cjs-pkg';\nglobalThis.__jlProbe = c.tag + ':second';\n");
    const second = await bundleAppForWeb({ entry, runtime: "browser", workingDirectory, packagesNodeModules, dataDir });
    expect("error" in second).toBe(false);
    if ("error" in second) return;
    expect(second.imports).toEqual(first.imports);

    expect(await runJoinedModule(joinVendorAndApp(vendor.code, second.code))).toBe("cjs-default:second");
  });

  test("an entry with no packages needs no vendor chunk at all", async () => {
    await writeFile(join(workingDirectory, "entry.js"), "globalThis.__jlProbe = 'no-packages';\n");

    const app = await bundleAppForWeb({
      entry: join(workingDirectory, "entry.js"),
      runtime: "browser",
      workingDirectory,
      packagesNodeModules,
      dataDir,
    });

    expect("error" in app).toBe(false);
    if ("error" in app) return;
    expect(app.imports).toEqual([]);
    expect(await runJoinedModule(joinVendorAndApp(null, app.code))).toBe("no-packages");
  });

  // The cache key is the `bun.lock` hash plus the import set, and `bun.lock` describes the shared packages folder
  // only. A package resolved out of the tab's own working directory is outside everything that key can see, so a
  // vendor chunk containing one must never be cached (nor served): the user could change it with no key change.
  test("a vendor chunk built only from the shared packages folder is cacheable; one touching the working directory is not", async () => {
    await writeFixturePackages();
    await writePackage(join(workingDirectory, "node_modules"), "wd-pkg", "export default 'from-wd';");

    await writeFile(join(workingDirectory, "shared-only.js"), "import c from 'cjs-pkg';\nglobalThis.__jlProbe = c;\n");
    const sharedOnly = await bundleAppForWeb({
      entry: join(workingDirectory, "shared-only.js"),
      runtime: "browser",
      workingDirectory,
      packagesNodeModules,
      dataDir,
    });
    expect("error" in sharedOnly).toBe(false);
    if ("error" in sharedOnly) return;
    expect(sharedOnly.vendorCacheable).toBe(true);

    await writeFile(
      join(workingDirectory, "with-wd.js"),
      "import c from 'cjs-pkg';\nimport w from 'wd-pkg';\nglobalThis.__jlProbe = [c, w];\n",
    );
    const withWd = await bundleAppForWeb({
      entry: join(workingDirectory, "with-wd.js"),
      runtime: "browser",
      workingDirectory,
      packagesNodeModules,
      dataDir,
    });
    expect("error" in withWd).toBe(false);
    if ("error" in withWd) return;
    expect(withWd.vendorCacheable).toBe(false);
  });

  test("a package a run imports but that has since disappeared fails the vendor build with the specifier", async () => {
    const vendor = await bundleVendorForWeb({
      imports: ["totally-missing-pkg"],
      runtime: "browser",
      workingDirectory,
      packagesNodeModules,
      dataDir,
    });

    expect("error" in vendor).toBe(true);
    if (!("error" in vendor)) return;
    expect(vendor.error.specifier).toBe("totally-missing-pkg");
  });

  test("a stylesheet imported by a package is injected from the vendor chunk", async () => {
    const pkgDir = join(packagesNodeModules, "styled-pkg");
    await mkdir(pkgDir, { recursive: true });
    await writeFile(join(pkgDir, "package.json"), JSON.stringify({ name: "styled-pkg", main: "index.js" }));
    await writeFile(join(pkgDir, "styles.css"), "body { color: teal; }");
    await writeFile(join(pkgDir, "index.js"), "import './styles.css';\nexport default 'styled';\n");
    await writeFile(join(workingDirectory, "entry.js"), "import s from 'styled-pkg';\nglobalThis.__jlProbe = s;\n");

    const app = await bundleAppForWeb({
      entry: join(workingDirectory, "entry.js"),
      runtime: "browser",
      workingDirectory,
      packagesNodeModules,
      dataDir,
    });
    expect("error" in app).toBe(false);
    if ("error" in app) return;
    const vendor = await bundleVendorForWeb({
      imports: app.imports,
      runtime: "browser",
      workingDirectory,
      packagesNodeModules,
      dataDir,
    });
    expect("error" in vendor).toBe(false);
    if ("error" in vendor) return;
    expect(vendor.code).toContain("body { color: teal; }");
  });
});
