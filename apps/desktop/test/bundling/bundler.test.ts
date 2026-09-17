import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

/**
 * The `browser` export condition at a package's entry point.
 *
 * `jslabResolve` resolves a bare specifier with `Bun.resolveSync` and hands `Bun.build` the resulting **file
 * path**, which is what gives the plugin its working-directory-first precedence and its containment check against
 * Bun's ancestor walk. The cost, until this was fixed: `Bun.resolveSync` is the *runtime* resolver and has no
 * `browser` condition, so it picks the `default`/`node` branch of an `exports` map -- and because the plugin hands
 * back a concrete path, `Bun.build({target:"browser"})` never gets to apply the `browser` condition it would have
 * chosen on its own. Measured against the same fixture: plain `Bun.build` picks the browser entry, while
 * `Bun.resolveSync` picks the node one.
 *
 * Reported as: `import { nanoid } from 'nanoid'` in a browser tab dying with
 * `ReferenceError: Can't find variable: Buffer`. nanoid@6.0.1's `exports["."]` is
 * `{ browser: "./index.browser.js", default: "./index.js" }`, and its `default` entry calls `Buffer.allocUnsafe`
 * -- a **free global**, not an import, so `nodePolyfills`'s builtin-blocking resolve hook never sees it, the build
 * succeeds, and the page throws at run time instead.
 *
 * These tests assert on the bundle **text** rather than executing it. Executing would be vacuous: `runJoinedModule`
 * evaluates under Bun, which has a real `Buffer` global, so the node entry runs perfectly there and the assertion
 * could never fail. The browser's missing `Buffer` is exactly what the test process cannot reproduce, so the
 * presence of the node entry's source in the chunk is the thing to pin.
 */
describe("the browser export condition", () => {
  /** A package with distinct node and browser entries, the node one referencing a browser-absent global. */
  async function writeDualEntryPackage(nodeModulesDir: string, name: string, tag: string, pkgJson: object) {
    const pkgDir = join(nodeModulesDir, name);
    await mkdir(pkgDir, { recursive: true });
    await writeFile(join(pkgDir, "package.json"), JSON.stringify({ name, type: "module", ...pkgJson }));
    // `gen` is built by a factory CALLED AT MODULE INIT, mirroring nanoid's own
    // `export const nanoid = customAlphabet(urlAlphabet)`. That shape is load-bearing: a `Buffer` reference
    // reachable only from an unused export is tree-shaken out of the chunk, and the test would pass vacuously.
    await writeFile(
      join(pkgDir, "index.js"),
      [
        "function make() { return (n) => Buffer.allocUnsafe(n).toString('latin1'); }",
        "export const gen = make();",
        `export const which = '${tag}-NODE-ENTRY';`,
        "",
      ].join("\n"),
    );
    await writeFile(
      join(pkgDir, "index.browser.js"),
      [`export const gen = (n) => 'x'.repeat(n);`, `export const which = '${tag}-BROWSER-ENTRY';`, ""].join("\n"),
    );
  }

  /**
   * nanoid@6.0.1's exact `exports` entry shape: a `browser` condition beside a `default` one.
   *
   * This deliberately carries no top-level `browser` field. It used to, and that field asserted nothing: measured,
   * an `exports` browser condition selects a file the `browser` map has no key for, so the map cannot fire and the
   * test passed identically with the field removed. The `browser` field's two forms are covered on their own
   * fixtures below, where they are the only thing that can decide the answer.
   */
  const BROWSER_CONDITION_EXPORTS = { ".": { browser: "./index.browser.js", default: "./index.js" } };

  for (const runtime of ["browser", "browser-node"] as const) {
    test(`${runtime}: a package with a browser export condition bundles its browser entry, not its node one`, async () => {
      await writeDualEntryPackage(packagesNodeModules, "dual-pkg", "P", { exports: BROWSER_CONDITION_EXPORTS });
      const entry = join(workingDirectory, "entry.js");
      await writeFile(entry, "import { gen, which } from 'dual-pkg';\nglobalThis.__jlProbe = which + gen(3);\n");

      const app = await bundleAppForWeb({ entry, runtime, workingDirectory, packagesNodeModules, dataDir });
      expect("error" in app).toBe(false);
      if ("error" in app) return;
      const vendor = await bundleVendorForWeb({
        imports: app.imports,
        runtime,
        workingDirectory,
        packagesNodeModules,
        dataDir,
      });
      expect("error" in vendor).toBe(false);
      if ("error" in vendor) return;
      const joined = joinVendorAndApp(vendor.code, app.code);

      expect(joined).toContain("P-BROWSER-ENTRY");
      expect(joined).not.toContain("P-NODE-ENTRY");
      // The user-visible symptom: a free `Buffer` reference surviving into a chunk that runs in a page with none.
      expect(joined).not.toContain("Buffer.allocUnsafe");
    });
  }

  test("a subpath export with a browser condition also resolves to its browser entry", async () => {
    const pkgDir = join(packagesNodeModules, "subpath-pkg");
    await mkdir(join(pkgDir, "feature"), { recursive: true });
    await writeFile(
      join(pkgDir, "package.json"),
      JSON.stringify({
        name: "subpath-pkg",
        type: "module",
        exports: { "./feature": { browser: "./feature/browser.js", default: "./feature/node.js" } },
      }),
    );
    await writeFile(join(pkgDir, "feature", "node.js"), "export const which = 'SUB-NODE-ENTRY';\n");
    await writeFile(join(pkgDir, "feature", "browser.js"), "export const which = 'SUB-BROWSER-ENTRY';\n");
    const entry = join(workingDirectory, "entry.js");
    await writeFile(entry, "import { which } from 'subpath-pkg/feature';\nglobalThis.__jlProbe = which;\n");

    expect(await runJoinedModule(await bundleAndJoin(entry))).toBe("SUB-BROWSER-ENTRY");
  });

  // The override must not reach past the containment check that keeps resolution inside the two intended
  // directories. If it re-resolved from the wrong base, this would load the shared folder's copy instead.
  test("working-directory precedence still wins for a package that has a browser condition in both places", async () => {
    await writeDualEntryPackage(join(workingDirectory, "node_modules"), "dual-pkg", "WD", {
      exports: BROWSER_CONDITION_EXPORTS,
    });
    await writeDualEntryPackage(packagesNodeModules, "dual-pkg", "PKGS", {
      exports: BROWSER_CONDITION_EXPORTS,
    });
    const entry = join(workingDirectory, "entry.js");
    await writeFile(entry, "import { which } from 'dual-pkg';\nglobalThis.__jlProbe = which;\n");

    const app = await bundleAppForWeb({ entry, runtime: "browser", workingDirectory, packagesNodeModules, dataDir });
    expect("error" in app).toBe(false);
    if ("error" in app) return;
    // Resolved out of the working directory, so the chunk stays unkeyable -- the override must not hide provenance.
    expect(app.vendorCacheable).toBe(false);
    expect(await runJoinedModule(await bundleAndJoin(entry))).toBe("WD-BROWSER-ENTRY");
  });

  // The override fires only for packages that actually declare a browser entry. Everything else must resolve
  // exactly as it did before, or this fix would silently repoint packages it has no business touching.
  test("a package with an exports map but no browser condition still resolves to its default entry", async () => {
    const pkgDir = join(packagesNodeModules, "plain-exports-pkg");
    await mkdir(pkgDir, { recursive: true });
    await writeFile(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: "plain-exports-pkg", type: "module", exports: { ".": { default: "./main.js" } } }),
    );
    await writeFile(join(pkgDir, "main.js"), "export const which = 'PLAIN-DEFAULT-ENTRY';\n");
    const entry = join(workingDirectory, "entry.js");
    await writeFile(entry, "import { which } from 'plain-exports-pkg';\nglobalThis.__jlProbe = which;\n");

    expect(await runJoinedModule(await bundleAndJoin(entry))).toBe("PLAIN-DEFAULT-ENTRY");
  });

  test("a package with no exports map at all is untouched", async () => {
    await writePackage(packagesNodeModules, "no-exports-pkg", "export const which = 'NO-EXPORTS-ENTRY';", {
      type: "module",
    });
    const entry = join(workingDirectory, "entry.js");
    await writeFile(entry, "import { which } from 'no-exports-pkg';\nglobalThis.__jlProbe = which;\n");

    expect(await runJoinedModule(await bundleAndJoin(entry))).toBe("NO-EXPORTS-ENTRY");
  });

  /*
   * Everything below is checked against the strongest oracle available: **Bun itself**.
   *
   * `jslabResolve` exists to hand `Bun.build` a path Bun would have chosen anyway, with working-directory
   * precedence bolted on. So for each fixture, the question "is this right?" has a mechanical answer -- build the
   * same package with a plain `Bun.build({target:"browser"})` and no plugins at all, and see which file Bun picks.
   * Each test pins both answers to the same explicit expectation, so a fixture that silently stopped selecting
   * anything fails rather than passing on two empty lists.
   *
   * These fixtures live in the **working directory's** own `node_modules`, not the shared packages folder, because
   * that is the one layout both resolvers can see: `jslabResolve` tries the working directory first, and a plain
   * Bun build from an entry inside it finds the package by the ordinary ancestor walk. The shared folder is a
   * sibling of the entry, invisible to Bun's own resolver, so an oracle built there could never resolve.
   *
   * Like the tests above, these assert on bundle **text**: executing under Bun would be vacuous, since Bun has a
   * real `Buffer` and the node entry runs fine there.
   */

  /** What a plain `Bun.build({target:"browser"})` -- no plugins, no JSLab -- makes of the same fixture. */
  async function plainBunBrowserBuild(
    entry: string,
  ): Promise<{ ok: true; code: string } | { ok: false; error: string }> {
    try {
      const built = await Bun.build({ entrypoints: [entry], target: "browser" });
      if (!built.success) return { ok: false, error: built.logs.map(String).join(" | ") };
      const [output] = built.outputs;
      if (!output) return { ok: false, error: "the oracle build produced no output" };
      return { ok: true, code: await output.text() };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  }

  /** Which of `markers` survived into `code`, in `markers`' own order. */
  function markersIn(code: string, markers: string[]): string[] {
    return markers.filter((marker) => code.includes(marker));
  }

  /** Asserts JSLab's bundle and Bun's own bundle of the same fixture both select exactly `expected`. */
  async function expectAgreesWithBun(entry: string, markers: string[], expected: string[]): Promise<void> {
    const oracle = await plainBunBrowserBuild(entry);
    expect(oracle.ok).toBe(true);
    if (!oracle.ok) return;
    expect(markersIn(oracle.code, markers)).toEqual(expected);
    expect(markersIn(await bundleAndJoin(entry), markers)).toEqual(expected);
  }

  /** Writes a package into the working directory's own `node_modules` -- the layout both resolvers can see. */
  async function writeWdPackage(name: string, pkgJson: object, files: Record<string, string>): Promise<void> {
    const pkgDir = join(workingDirectory, "node_modules", name);
    await mkdir(pkgDir, { recursive: true });
    await writeFile(
      join(pkgDir, "package.json"),
      JSON.stringify({ name, version: "1.0.0", type: "module", ...pkgJson }),
    );
    for (const [relative, contents] of Object.entries(files)) {
      const full = join(pkgDir, relative);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, contents);
    }
  }

  async function writeEntry(source: string, name = "entry.js"): Promise<string> {
    const entry = join(workingDirectory, name);
    await writeFile(entry, source);
    return entry;
  }

  /** An ES module whose single export tags which file it is. Assigned on the entry so it is never tree-shaken. */
  const mod = (marker: string) => `export const which = '${marker}';\n`;
  const importWhich = (specifier: string) => `import { which } from '${specifier}';\nglobalThis.__jlProbe = which;\n`;

  test("a `*` pattern key is matched most-specific-first, not in the manifest's key order", async () => {
    await writeWdPackage(
      "star-pkg",
      {
        exports: {
          "./*": { browser: "./general/*.js", default: "./fallback-general/*.js" },
          "./feature/*": { browser: "./specific/*.js", default: "./fallback/*.js" },
        },
      },
      {
        "general/feature/x.js": mod("STAR-GENERAL"),
        "specific/x.js": mod("STAR-SPECIFIC"),
        "fallback/x.js": mod("STAR-DEFAULT"),
        "fallback-general/feature/x.js": mod("STAR-DEFAULT-GENERAL"),
      },
    );
    const entry = await writeEntry(importWhich("star-pkg/feature/x"));

    // First-match-in-key-order picked `./general/feature/x.js` here; Bun picks the specific pattern.
    await expectAgreesWithBun(
      entry,
      ["STAR-GENERAL", "STAR-SPECIFIC", "STAR-DEFAULT", "STAR-DEFAULT-GENERAL"],
      ["STAR-SPECIFIC"],
    );
  });

  test("`*` pattern specificity does not depend on the order the keys appear in", async () => {
    await writeWdPackage(
      "star-order-pkg",
      {
        exports: {
          "./feature/*": { browser: "./specific/*.js", default: "./fallback/*.js" },
          "./*": { browser: "./general/*.js", default: "./fallback-general/*.js" },
        },
      },
      {
        "general/feature/x.js": mod("ORDER-GENERAL"),
        "specific/x.js": mod("ORDER-SPECIFIC"),
        "fallback/x.js": mod("ORDER-DEFAULT"),
        "fallback-general/feature/x.js": mod("ORDER-DEFAULT-GENERAL"),
      },
    );
    const entry = await writeEntry(importWhich("star-order-pkg/feature/x"));

    await expectAgreesWithBun(
      entry,
      ["ORDER-GENERAL", "ORDER-SPECIFIC", "ORDER-DEFAULT", "ORDER-DEFAULT-GENERAL"],
      ["ORDER-SPECIFIC"],
    );
  });

  test("an `exports` array target selects its first member when that member exists", async () => {
    await writeWdPackage(
      "array-pkg",
      { exports: { ".": { browser: ["./first.js", "./second.js"], default: "./index.js" } } },
      { "index.js": mod("ARRAY-NODE"), "first.js": mod("ARRAY-FIRST"), "second.js": mod("ARRAY-SECOND") },
    );
    const entry = await writeEntry(importWhich("array-pkg"));

    await expectAgreesWithBun(entry, ["ARRAY-NODE", "ARRAY-FIRST", "ARRAY-SECOND"], ["ARRAY-FIRST"]);
  });

  // A deliberate divergence from Bun, asserted rather than hidden. The `exports` spec makes an array a *fallback
  // list*, but Bun does not walk it: measured with no plugin at all, a `browser` array whose first member does not
  // exist makes a plain browser-target build fail outright with `Could not resolve: "missing-first-pkg"`. JSLab
  // walks to the first member that exists, which is what the spec prescribes and is strictly more forgiving -- it
  // can only turn a build Bun would have failed into one that succeeds, never the reverse. Before this, the first
  // member was returned unchecked and its failed existence check abandoned the whole override, so the package fell
  // all the way back to its node entry -- the one answer that is wrong under both readings.
  test("an `exports` array falls through to the first member that exists (deliberately unlike Bun)", async () => {
    await writeWdPackage(
      "missing-first-pkg",
      { exports: { ".": { browser: ["./missing.js", "./second.js"], default: "./index.js" } } },
      { "index.js": mod("FALLBACK-NODE"), "second.js": mod("FALLBACK-SECOND") },
    );
    const entry = await writeEntry(importWhich("missing-first-pkg"));

    const oracle = await plainBunBrowserBuild(entry);
    expect(oracle.ok).toBe(false);
    const joined = await bundleAndJoin(entry);
    expect(joined).toContain("FALLBACK-SECOND");
    expect(joined).not.toContain("FALLBACK-NODE");
  });

  test("an `exports` array of condition objects skips members that match no condition", async () => {
    await writeWdPackage(
      "array-cond-pkg",
      { exports: { ".": [{ node: "./node.js" }, { browser: "./browser.js", default: "./default.js" }] } },
      { "node.js": mod("COND-NODE"), "browser.js": mod("COND-BROWSER"), "default.js": mod("COND-DEFAULT") },
    );
    const entry = await writeEntry(importWhich("array-cond-pkg"));

    await expectAgreesWithBun(entry, ["COND-NODE", "COND-BROWSER", "COND-DEFAULT"], ["COND-BROWSER"]);
  });

  test("a `browser` condition nested inside an `import` condition is still selected", async () => {
    await writeWdPackage(
      "nested-pkg",
      { exports: { ".": { import: { browser: "./ib.js", default: "./id.js" }, default: "./index.js" } } },
      { "index.js": mod("NESTED-PLAIN"), "ib.js": mod("NESTED-IMPORT-BROWSER"), "id.js": mod("NESTED-IMPORT-DEFAULT") },
    );
    const entry = await writeEntry(importWhich("nested-pkg"));

    await expectAgreesWithBun(
      entry,
      ["NESTED-PLAIN", "NESTED-IMPORT-BROWSER", "NESTED-IMPORT-DEFAULT"],
      ["NESTED-IMPORT-BROWSER"],
    );
  });

  // `require("pkg")` and `import ... from "pkg"` select different branches, so the condition set follows the
  // resolution kind. With the set fixed at the `import` spelling this resolved to `./import.js`, where Bun -- and
  // the spec -- take the `require` branch and its nested `browser` condition.
  //
  // The `require` here is made from **inside another package**, which is both where it matters and the only place
  // the kind survives. A tab's *own* top-level `require` is answered from the vendor registry stub, and the vendor
  // build then re-imports the specifier with an `import` statement of its own making -- so that one path reaches
  // this plugin as an import-kind resolution no matter how the tab spelled it. Recorded as a known gap; closing it
  // would mean carrying each specifier's import kind across the app/vendor split and into the vendor cache key.
  test("a `require()`-kind resolution takes the `require` branch, not the `import` one", async () => {
    await writeWdPackage(
      "require-pkg",
      {
        type: "commonjs",
        exports: {
          ".": { require: { browser: "./rb.js", default: "./rn.js" }, import: "./import.js", default: "./index.js" },
        },
      },
      {
        "index.js": "module.exports = { which: 'REQ-DEFAULT' };\n",
        "rb.js": "module.exports = { which: 'REQ-BROWSER' };\n",
        "rn.js": "module.exports = { which: 'REQ-NODE' };\n",
        "import.js": "module.exports = { which: 'REQ-IMPORT' };\n",
      },
    );
    await writeWdPackage(
      "require-outer-pkg",
      { type: "commonjs", main: "./index.js" },
      { "index.js": "module.exports = { which: require('require-pkg').which };\n" },
    );
    const entry = await writeEntry(importWhich("require-outer-pkg"));

    await expectAgreesWithBun(entry, ["REQ-DEFAULT", "REQ-BROWSER", "REQ-NODE", "REQ-IMPORT"], ["REQ-BROWSER"]);
  });

  test("a scoped package's browser export condition resolves like any other package's", async () => {
    await writeWdPackage(
      "@scope/exports-pkg",
      { exports: { ".": { browser: "./browser.js", default: "./index.js" } } },
      { "index.js": mod("SCOPED-NODE"), "browser.js": mod("SCOPED-BROWSER") },
    );
    const entry = await writeEntry(importWhich("@scope/exports-pkg"));

    await expectAgreesWithBun(entry, ["SCOPED-NODE", "SCOPED-BROWSER"], ["SCOPED-BROWSER"]);
  });

  /*
   * The top-level `browser` field, both forms.
   *
   * An earlier round of this fix recorded that Bun ignores this field and that honouring it would make JSLab
   * diverge *from* Bun. That was measured wrongly and is false -- the four tests below are the correction, and each
   * one pins Bun's own answer beside JSLab's. It mattered: nanoid declares a `browser` map as well as its `exports`
   * condition, so Bun had two defences against a browser-hostile entry and this plugin was defeating both. Any
   * package whose only browser hint is this field kept loading its node entry, which is the originally reported
   * `ReferenceError: Can't find variable: Buffer` all over again.
   */

  test("a package whose only browser hint is a top-level `browser` string bundles its browser entry", async () => {
    await writeWdPackage(
      "field-string-pkg",
      { main: "./index.js", browser: "./index.browser.js" },
      { "index.js": mod("FIELD-STRING-NODE"), "index.browser.js": mod("FIELD-STRING-BROWSER") },
    );
    const entry = await writeEntry(importWhich("field-string-pkg"));

    await expectAgreesWithBun(entry, ["FIELD-STRING-NODE", "FIELD-STRING-BROWSER"], ["FIELD-STRING-BROWSER"]);
  });

  test("a package whose only browser hint is a top-level `browser` map bundles its browser entry", async () => {
    await writeWdPackage(
      "field-map-pkg",
      { main: "./index.js", browser: { "./index.js": "./index.browser.js" } },
      { "index.js": mod("FIELD-MAP-NODE"), "index.browser.js": mod("FIELD-MAP-BROWSER") },
    );
    const entry = await writeEntry(importWhich("field-map-pkg"));

    await expectAgreesWithBun(entry, ["FIELD-MAP-NODE", "FIELD-MAP-BROWSER"], ["FIELD-MAP-BROWSER"]);
  });

  test("a `browser` map key written without a leading `./` still matches", async () => {
    await writeWdPackage(
      "field-bare-key-pkg",
      { main: "./index.js", browser: { "index.js": "./index.browser.js" } },
      { "index.js": mod("BARE-KEY-NODE"), "index.browser.js": mod("BARE-KEY-BROWSER") },
    );
    const entry = await writeEntry(importWhich("field-bare-key-pkg"));

    await expectAgreesWithBun(entry, ["BARE-KEY-NODE", "BARE-KEY-BROWSER"], ["BARE-KEY-BROWSER"]);
  });

  test("a scoped package's top-level `browser` map is honoured too", async () => {
    await writeWdPackage(
      "@scope/field-pkg",
      { main: "./index.js", browser: { "./index.js": "./browser.js" } },
      { "index.js": mod("SCOPED-FIELD-NODE"), "browser.js": mod("SCOPED-FIELD-BROWSER") },
    );
    const entry = await writeEntry(importWhich("@scope/field-pkg"));

    await expectAgreesWithBun(entry, ["SCOPED-FIELD-NODE", "SCOPED-FIELD-BROWSER"], ["SCOPED-FIELD-BROWSER"]);
  });

  // The two fields' precedence, which is not symmetric. The string form replaces `main`, so an `exports` map --
  // which supersedes `main` outright -- supersedes it too. The map form rewrites whichever file was *selected*, so
  // it applies on top of an `exports` result. Both measured against Bun.
  test("a top-level `browser` string is superseded by an `exports` map, exactly as `main` is", async () => {
    await writeWdPackage(
      "string-vs-exports-pkg",
      { main: "./index.js", browser: "./index.browser.js", exports: { ".": "./index.js" } },
      { "index.js": mod("STRING-VS-EXPORTS-NODE"), "index.browser.js": mod("STRING-VS-EXPORTS-BROWSER") },
    );
    const entry = await writeEntry(importWhich("string-vs-exports-pkg"));

    await expectAgreesWithBun(
      entry,
      ["STRING-VS-EXPORTS-NODE", "STRING-VS-EXPORTS-BROWSER"],
      ["STRING-VS-EXPORTS-NODE"],
    );
  });

  test("a top-level `browser` map rewrites the file an `exports` map selected", async () => {
    await writeWdPackage(
      "map-over-exports-pkg",
      { main: "./index.js", browser: { "./index.js": "./index.browser.js" }, exports: { ".": "./index.js" } },
      { "index.js": mod("MAP-OVER-EXPORTS-NODE"), "index.browser.js": mod("MAP-OVER-EXPORTS-BROWSER") },
    );
    const entry = await writeEntry(importWhich("map-over-exports-pkg"));

    await expectAgreesWithBun(
      entry,
      ["MAP-OVER-EXPORTS-NODE", "MAP-OVER-EXPORTS-BROWSER"],
      ["MAP-OVER-EXPORTS-BROWSER"],
    );
  });

  test("an `exports` browser condition wins over a `browser` map that names a different file", async () => {
    await writeWdPackage(
      "both-pkg",
      {
        main: "./index.js",
        browser: { "./index.js": "./from-map.js" },
        exports: { ".": { browser: "./from-exports.js", default: "./index.js" } },
      },
      { "index.js": mod("BOTH-NODE"), "from-map.js": mod("BOTH-MAP"), "from-exports.js": mod("BOTH-EXPORTS") },
    );
    const entry = await writeEntry(importWhich("both-pkg"));

    await expectAgreesWithBun(entry, ["BOTH-NODE", "BOTH-MAP", "BOTH-EXPORTS"], ["BOTH-EXPORTS"]);
  });

  // The spec's "exclude this module from the browser build" marker. A stub module is the answer because it is
  // Bun's: measured, a plain browser-target build hands the importer `{}` for a `false`-mapped entry. Getting this
  // wrong breaks packages that deliberately exclude a file -- bundling the excluded node file would reintroduce
  // exactly the browser-hostile code the package went out of its way to drop.
  test("a `browser` map entry of `false` bundles an empty module instead of the package", async () => {
    await writeWdPackage(
      "excluded-pkg",
      { main: "./index.js", browser: { "./index.js": false } },
      { "index.js": "export const which = 'EXCLUDED-NODE';\nexport const b = Buffer.allocUnsafe(1);\n" },
    );
    const entry = await writeEntry("import * as ns from 'excluded-pkg';\nglobalThis.__jlProbe = typeof ns;\n");

    const oracle = await plainBunBrowserBuild(entry);
    expect(oracle.ok).toBe(true);
    if (!oracle.ok) return;
    expect(oracle.code).not.toContain("EXCLUDED-NODE");
    const joined = await bundleAndJoin(entry);
    expect(joined).not.toContain("EXCLUDED-NODE");
    // The excluded file's browser-hostile code must not reach the chunk either -- that is the point of the marker.
    expect(joined).not.toContain("Buffer.allocUnsafe");
  });

  // Half of the `browser` field's job is rewriting a package's own *internal* relative imports, which never reach
  // this plugin: its hook only ever sees bare specifiers. That half is Bun's, and it keeps working even though
  // `jslabResolve` hands Bun a concrete entry path -- pinned here so a future change to the override cannot
  // quietly take it over and disagree with Bun about it.
  test("a `browser` map still rewrites a package's own internal import, which Bun resolves", async () => {
    await writeWdPackage(
      "internal-pkg",
      { main: "./index.js", browser: { "./internal.js": "./internal.browser.js" } },
      {
        "index.js": "export { which } from './internal.js';\n",
        "internal.js": mod("INTERNAL-NODE"),
        "internal.browser.js": mod("INTERNAL-BROWSER"),
      },
    );
    const entry = await writeEntry(importWhich("internal-pkg"));

    await expectAgreesWithBun(entry, ["INTERNAL-NODE", "INTERNAL-BROWSER"], ["INTERNAL-BROWSER"]);
  });
});
