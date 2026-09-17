import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserEntryFor, jslabResolve } from "../../src/main/bundling/resolve-plugin";
import { MAX_PACKAGE_JSON_BYTES } from "../../src/main/fs/bounded-read";

let root = "";
let workingDirectory = "";
let packagesNodeModules = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "jslab-resolve-"));
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

/**
 * Captures the onResolve callback `jslabResolve` registers, so tests can drive it directly without paying for a
 * full `Bun.build`. Mirrors the slice of Bun's `PluginBuilder` the plugin actually calls.
 */
function driveResolve() {
  let callback:
    | ((args: { path: string; importer: string; namespace: string; resolveDir: string; kind: string }) => unknown)
    | null = null;
  const builder = {
    onResolve(_constraints: { filter: RegExp }, cb: typeof callback) {
      callback = cb;
    },
    onLoad() {},
  };
  return {
    builder,
    resolve: async (path: string, importer = join(workingDirectory, "entry.js")) => {
      if (!callback) throw new Error("onResolve was never registered");
      return callback({
        path,
        importer,
        namespace: "file",
        resolveDir: workingDirectory,
        kind: "import-statement",
      });
    },
  };
}

/**
 * F4. `browserEntryFor` read a third party's package.json with a synchronous, unbounded `readFileSync`, on
 * Main's loop during bundling: a multi-GB manifest blocked the loop outright and a FIFO never returned at all.
 * Both now fall through to "keep Bun's answer", the same path an unreadable manifest already took.
 */
describe("browserEntryFor", () => {
  test("refuses an oversized package.json and keeps Bun's answer", async () => {
    // Control first: this exact manifest shape, under the cap, does resolve to a browser entry. Without it, the
    // `toBeUndefined()` below would pass for any reason at all -- including a fixture that never resolved.
    const okDir = join(packagesNodeModules, "small");
    await mkdir(okDir, { recursive: true });
    await writeFile(join(okDir, "browser.js"), "export default 1;");
    await writeFile(join(okDir, "package.json"), JSON.stringify({ name: "small", browser: "./browser.js" }));
    expect(browserEntryFor("small", join(okDir, "index.js"))).toBeDefined();

    // The same manifest, valid JSON, padded past the cap: an unbounded read parses it and returns that entry.
    const pkgDir = join(packagesNodeModules, "huge");
    await mkdir(pkgDir, { recursive: true });
    await writeFile(join(pkgDir, "browser.js"), "export default 1;");
    await writeFile(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: "huge", browser: "./browser.js", pad: "x".repeat(MAX_PACKAGE_JSON_BYTES) }),
    );
    expect(browserEntryFor("huge", join(pkgDir, "index.js"))).toBeUndefined();
  });

  test("refuses a FIFO package.json rather than blocking the bundler", async () => {
    const pkgDir = join(packagesNodeModules, "piped");
    await mkdir(pkgDir, { recursive: true });
    expect(await Bun.spawn(["mkfifo", join(pkgDir, "package.json")]).exited).toBe(0);
    // This call is synchronous: a regression does not time out, it parks the thread and hangs the whole run.
    // The hang is the signal, which is exactly why the bound has to live in the reader rather than in a timeout.
    expect(browserEntryFor("piped", join(pkgDir, "index.js"))).toBeUndefined();
  });
});

describe("jslabResolve", () => {
  /**
   * F1. On a resolution *miss* this hook re-reads `args.importer` to position its "Cannot find module" error, and
   * that importer is third-party- or user-controlled: the vendor build resolves every transitive specifier, so it
   * can sit inside `node_modules` or the user's working directory. The read was a bare `readFileSync`, excused in
   * the unbounded-reads allowlist as "best-effort inside try/catch" -- a recoverability argument that answers
   * neither hazard, because `readFileSync` on a FIFO *blocks* and no try/catch can rescue a blocking syscall.
   * Measured before the fix by driving this exact hook with a FIFO importer under a hard alarm: it never returned
   * and had to be killed.
   */
  test("positions a miss from a regular importer, and refuses a FIFO one instead of hanging the build", async () => {
    // Control first: without it, the FIFO assertion below would pass for a hook that never read the importer.
    const real = join(workingDirectory, "entry.js");
    await writeFile(real, 'import x from "jslab-absent-pkg";\n');
    const positioned: Array<{ line?: number }> = [];
    const ok = driveResolve();
    jslabResolve({ workingDirectory, packagesNodeModules }, new Set<string>(), (error) => positioned.push(error)).setup(
      ok.builder as never,
    );
    await expect(ok.resolve("jslab-absent-pkg", real)).rejects.toThrow("unresolved bare specifier");
    expect(positioned[0]?.line).toBe(1);

    // The same hook, with a FIFO importer. This read is synchronous: a regression does not time out, it parks the
    // thread and hangs the whole run, which is exactly why the refusal belongs in the reader and not in a timeout.
    const fifo = join(root, "fifo-entry.js");
    expect(await Bun.spawn(["mkfifo", fifo]).exited).toBe(0);
    const piped: Array<{ line?: number }> = [];
    const blocked = driveResolve();
    jslabResolve({ workingDirectory, packagesNodeModules }, new Set<string>(), (error) => piped.push(error)).setup(
      blocked.builder as never,
    );
    await expect(blocked.resolve("jslab-absent-pkg", fifo)).rejects.toThrow("unresolved bare specifier");
    // The error still reports, just without a position -- the same fallback an unreadable importer already took.
    expect(piped[0]?.line).toBeUndefined();
  });

  test("resolves a package that exists only in the working directory's node_modules", async () => {
    await writePackage(join(workingDirectory, "node_modules"), "left-pad", "export default 'from-wd';");
    const imports = new Set<string>();
    const { builder, resolve } = driveResolve();
    jslabResolve({ workingDirectory, packagesNodeModules }, imports, () => {}).setup(builder as never);

    const result = (await resolve("left-pad")) as { path: string } | undefined;

    expect(result?.path).toContain(join(workingDirectory, "node_modules", "left-pad"));
    expect(imports.has("left-pad")).toBe(true);
  });

  test("prefers the working directory's node_modules when the same package exists in the packages folder too", async () => {
    await writePackage(join(workingDirectory, "node_modules"), "left-pad", "export default 'from-wd';");
    await writePackage(packagesNodeModules, "left-pad", "export default 'from-pkgs';");
    const { builder, resolve } = driveResolve();
    jslabResolve({ workingDirectory, packagesNodeModules }, new Set(), () => {}).setup(builder as never);

    const result = (await resolve("left-pad")) as { path: string } | undefined;

    expect(result?.path).toContain(join(workingDirectory, "node_modules", "left-pad"));
    expect(result?.path).not.toContain(join(packagesNodeModules, "left-pad"));
  });

  test("falls back to the packages node_modules when the package isn't in the working directory", async () => {
    await writePackage(packagesNodeModules, "right-pad", "export default 'from-pkgs';");
    const { builder, resolve } = driveResolve();
    jslabResolve({ workingDirectory, packagesNodeModules }, new Set(), () => {}).setup(builder as never);

    const result = (await resolve("right-pad")) as { path: string } | undefined;

    expect(result?.path).toContain(join(packagesNodeModules, "right-pad"));
  });

  // Fix round 1, C1: a miss must not defer to Bun's own (ancestor-walking) resolver by returning `undefined` --
  // it must force a failure and report it through `onError`, exactly like a genuinely missing package always did.
  test("fails a bare specifier that exists in neither location, reporting it through onError", async () => {
    const errors: Array<{ specifier?: string }> = [];
    const { builder, resolve } = driveResolve();
    jslabResolve({ workingDirectory, packagesNodeModules }, new Set(), (error) => errors.push(error)).setup(
      builder as never,
    );

    await expect(resolve("totally-missing-pkg")).rejects.toThrow();

    expect(errors).toHaveLength(1);
    expect(errors[0]?.specifier).toBe("totally-missing-pkg");
  });
});
