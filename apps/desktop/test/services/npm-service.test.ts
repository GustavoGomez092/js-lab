import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OperationQueue } from "@jslab/npm";
import type { NpmListResult, NpmOperation } from "@jslab/rpc-schema";
import { resolveAppPaths } from "../../src/main/app-paths";
import {
  MAX_SEARCH_BODY_BYTES,
  NpmService,
  type NpmServiceDeps,
  OUTDATED_TTL_MS,
} from "../../src/main/services/npm-service";
import type { NpmSpawn, NpmSpawnOptions, NpmSpawnResult } from "../../src/main/services/npm-spawn";
import { ensurePackagesProject } from "../../src/main/services/packages-project";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jslab-npm-service-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface Call {
  argv: readonly string[];
  cwd: string;
  env: Record<string, string>;
  signal: AbortSignal;
}

async function setup(
  overrides: Partial<NpmServiceDeps> & {
    respond?: (argv: readonly string[], options: NpmSpawnOptions) => Promise<NpmSpawnResult>;
  } = {},
) {
  const paths = resolveAppPaths({ resourcesFolder: "/R", userData: join(dir, "data"), execPath: "/bun", env: {} });
  await ensurePackagesProject(paths, () => {});
  const calls: Call[] = [];
  const ops: NpmOperation[] = [];
  const logs: string[] = [];
  const changed: NpmListResult[] = [];
  let afterChange = 0;
  const respond =
    overrides.respond ??
    (async (argv: readonly string[]) => ({ exitCode: 0, stdout: `installed ${argv.at(-1)}\n`, stderr: "" }));
  const spawn: NpmSpawn = async (argv, options) => {
    calls.push({ argv, cwd: options.cwd, env: options.env, signal: options.signal });
    options.onOutput(`running ${argv.join(" ")}\n`);
    return respond(argv, options);
  };
  let id = 0;
  const service = new NpmService({
    paths,
    baseEnv: () => ({ PATH: "/usr/bin:/bin" }),
    realHome: join(dir, "real-home"),
    settings: () => ({ allowInstallScripts: false, autoInstallTypes: false }),
    spawn,
    newId: () => `op${++id}`,
    onOperation: (op) => ops.push(op),
    onLog: (_opId, text) => logs.push(text),
    onChanged: (list) => changed.push(list),
    afterChange: () => {
      afterChange++;
    },
    log: () => {},
    ...overrides,
  });
  return { service, paths, calls, ops, logs, changed, afterChange: () => afterChange };
}

describe("NpmService (spec §11.3)", () => {
  test("npm operations never see the user's ~/.npmrc: the M0-S8 discriminating pair with an injected spawn", async () => {
    // A user home whose only .npmrc line is a dead scoped registry (M0-S8 Run 3).
    const userHome = join(dir, "user-home");
    await mkdir(userHome, { recursive: true });
    await writeFile(join(userHome, ".npmrc"), "@jslab-fixture:registry=http://127.0.0.1:9/\n");
    // Behaves like Bun 1.4.0: reads $HOME/.npmrc and honours BUN_CONFIG_*/NPM_CONFIG_* variables.
    const bunLike = async (
      argv: readonly string[],
      options: { env: Record<string, string> },
    ): Promise<NpmSpawnResult> => {
      const rc = join(options.env.HOME ?? "", ".npmrc");
      const userRc = existsSync(rc) ? readFileSync(rc, "utf8") : "";
      const spec = String(argv.at(-1));
      const scope = spec.startsWith("@") ? spec.split("/")[0] : null;
      if (scope && userRc.includes(`${scope}:registry=http://127.0.0.1:9/`)) {
        return { exitCode: 1, stdout: "", stderr: `error: ConnectionRefused downloading package manifest ${spec}\n` };
      }
      if (Object.keys(options.env).some((key) => /^(bun_config_|npm_config_)/i.test(key))) {
        return { exitCode: 1, stdout: "", stderr: "error: ConnectionRefused (leaked config)\n" };
      }
      return { exitCode: 0, stdout: `installed ${spec}\n`, stderr: "" };
    };
    // Control: the fake discriminates when HOME is the user home.
    expect(
      (await bunLike(["add", "--exact", "@jslab-fixture/scoped@1.0.0"], { env: { HOME: userHome } })).exitCode,
    ).toBe(1);

    const { service, paths, calls, ops } = await setup({
      baseEnv: () => ({
        PATH: "/usr/bin:/bin",
        HOME: userHome,
        BUN_CONFIG_REGISTRY: "http://127.0.0.1:9/",
        npm_config_userconfig: join(userHome, ".npmrc"),
      }),
      realHome: userHome,
      respond: (argv, options) => bunLike(argv, options),
    });
    service.install("@jslab-fixture/scoped@1.0.0");
    await service.whenIdle();
    expect(ops.at(-1)).toMatchObject({ status: "succeeded", error: null });
    expect(calls[0]?.env.HOME).toBe(paths.npmHome);
    expect(calls[0]?.env.BUN_INSTALL_CACHE_DIR).toBe(join(userHome, ".bun", "install", "cache"));
    expect(calls[0]?.cwd).toBe(paths.packagesDir);
    expect(readdirSync(paths.npmHome)).toEqual([]);
    expect(readFileSync(join(userHome, ".npmrc"), "utf8")).toBe("@jslab-fixture:registry=http://127.0.0.1:9/\n");
  });

  test("an install emits queued, running and succeeded, streams output, then recycles once and reports the new list", async () => {
    const { service, paths, calls, ops, logs, changed, afterChange } = await setup({
      respond: async () => {
        await writeFile(
          join(dir, "data", "packages", "package.json"),
          JSON.stringify({
            name: "jslab-packages",
            private: true,
            dependencies: { zod: "4.6.4" },
            trustedDependencies: [],
          }),
        );
        await mkdir(join(dir, "data", "packages", "node_modules", "zod"), { recursive: true });
        await writeFile(
          join(dir, "data", "packages", "node_modules", "zod", "package.json"),
          JSON.stringify({ version: "4.6.4" }),
        );
        return { exitCode: 0, stdout: "installed zod@4.6.4\n", stderr: "" };
      },
    });
    const op = service.install("zod@4.6.4");
    expect(op).toEqual({
      id: "op1",
      kind: "install",
      target: "zod@4.6.4",
      status: "queued",
      error: null,
      notice: null,
    });
    await service.whenIdle();
    expect(ops.map((o) => o.status)).toEqual(["queued", "running", "succeeded"]);
    expect(calls.map((call) => call.argv)).toEqual([["add", "--exact", "zod@4.6.4"]]);
    expect(logs).toEqual(["running add --exact zod@4.6.4\n"]);
    expect(afterChange()).toBe(1);
    expect(changed.at(-1)?.installed).toEqual([{ name: "zod", version: "4.6.4", latest: null }]);
    expect(existsSync(paths.packagesJson)).toBe(true);

    service.remove("zod");
    service.update("zod");
    service.updateAll();
    await service.whenIdle();
    expect(calls.slice(1).map((call) => call.argv)).toEqual([
      ["remove", "zod"],
      ["add", "--exact", "zod@latest"],
      ["add", "--exact", "zod@latest"],
    ]);
  });

  test("operations run one at a time, and a classified failure doesn't recycle or report a change", async () => {
    let running = 0;
    let maxRunning = 0;
    const { service, ops, changed, afterChange } = await setup({
      respond: async (argv) => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        await Bun.sleep(10);
        running--;
        return argv.at(-1) === "bad@1.0.0"
          ? { exitCode: 1, stdout: "", stderr: "error: ConnectionRefused downloading package manifest bad\n" }
          : { exitCode: 0, stdout: "installed ok@1.0.0\n", stderr: "" };
      },
    });
    service.install("bad@1.0.0");
    service.install("ok@1.0.0");
    await service.whenIdle();
    expect(maxRunning).toBe(1);
    const failed = ops.find((op) => op.target === "bad@1.0.0" && op.status === "failed");
    expect(failed?.error?.kind).toBe("network");
    expect(afterChange()).toBe(1);
    expect(changed).toHaveLength(1);
  });

  test("with install scripts allowed, a registry package is trusted before install and a git spec after it", async () => {
    const manifestPath = join(dir, "data", "packages", "package.json");
    const { service, calls } = await setup({
      settings: () => ({ allowInstallScripts: true, autoInstallTypes: false }),
      respond: async (argv) => {
        if (argv[0] === "add" && String(argv.at(-1)).startsWith("git+")) {
          const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
          manifest.dependencies["from-git"] = "git+https://example.test/from-git.git";
          await writeFile(manifestPath, JSON.stringify(manifest));
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    service.install("fixture-script@1.0.0");
    await service.whenIdle();
    expect(JSON.parse(await readFile(manifestPath, "utf8")).trustedDependencies).toEqual(["fixture-script"]);
    service.install("git+https://example.test/from-git.git");
    await service.whenIdle();
    expect(calls.map((call) => call.argv)).toEqual([
      ["add", "--exact", "fixture-script@1.0.0"],
      ["add", "--exact", "git+https://example.test/from-git.git"],
      ["pm", "trust", "from-git"],
    ]);
    service.remove("fixture-script");
    await service.whenIdle();
    expect(JSON.parse(await readFile(manifestPath, "utf8")).trustedDependencies).toEqual([]);
  });

  test("an operation that exceeds the queue timeout fails as a timeout and its spawn is aborted", async () => {
    const { service, ops, calls } = await setup({
      queue: new OperationQueue({ timeoutMs: 20 }),
      respond: (_argv, options) =>
        new Promise((resolve) =>
          options.signal.addEventListener("abort", () => resolve({ exitCode: null, stdout: "", stderr: "killed" })),
        ),
    });
    service.install("slow@1.0.0");
    await service.whenIdle();
    expect(ops.at(-1)).toMatchObject({ status: "failed", error: { kind: "timeout" } });
    expect(calls[0]?.signal.aborted).toBe(true);
  });

  test("a timed-out operation that settles within the grace keeps the child's output in its log", async () => {
    const { service, ops } = await setup({
      queue: new OperationQueue({ timeoutMs: 20 }),
      // Settles from the abort event itself (fix round 2, R-M3-FLAKE-7b): no timer, so this can't flake.
      respond: (_argv, options) =>
        new Promise((resolve) =>
          options.signal.addEventListener("abort", () =>
            resolve({ exitCode: null, stdout: "marker-stdout", stderr: "marker-stderr" }),
          ),
        ),
    });
    service.install("slow@1.0.0");
    await service.whenIdle();
    const last = ops.at(-1);
    expect(last).toMatchObject({ status: "failed", error: { kind: "timeout" } });
    expect(last?.error?.log).toContain("marker-stdout");
    expect(last?.error?.log).toContain("marker-stderr");
  });

  test("a malformed package.json fails the operation and is never overwritten", async () => {
    const { service, ops, calls, paths } = await setup({
      settings: () => ({ allowInstallScripts: true, autoInstallTypes: false }),
    });
    const manifestPath = paths.packagesJson;
    const bytesBefore = '{ "name": "jslab-packages", "dependencies": { "a": "1.0.0", }, }';
    await writeFile(manifestPath, bytesBefore);
    service.install("fixture@1.0.0");
    await service.whenIdle();
    expect(await readFile(manifestPath, "utf8")).toBe(bytesBefore);
    expect(ops.at(-1)).toMatchObject({ status: "failed", error: { kind: "unknown" } });
    expect(calls.some((call) => call.argv[0] === "add")).toBe(false);
  });

  test("list retries a transient manifest parse failure once, then reports the error", async () => {
    const manifestPath = join(dir, "data", "packages", "package.json");
    // Fix round 2 (FLAKE-3): a gate proves the retry path was actually entered before any fix-up write lands, so
    // the test can never pass because the FIRST read happened to overtake the swap.
    let reached!: () => void;
    const retryReached = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let release!: () => void;
    const retryGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { service } = await setup({
      listRetryWait: () => {
        reached();
        return retryGate;
      },
    });

    await writeFile(manifestPath, "{ not json");
    const listPromise = service.list();
    await retryReached;

    // Every fix-up write is awaited before the retry is allowed to proceed.
    await writeFile(
      manifestPath,
      JSON.stringify({
        name: "jslab-packages",
        private: true,
        dependencies: { zod: "4.6.4" },
        trustedDependencies: [],
      }),
    );
    await mkdir(join(dir, "data", "packages", "node_modules", "zod"), { recursive: true });
    await writeFile(
      join(dir, "data", "packages", "node_modules", "zod", "package.json"),
      JSON.stringify({ version: "4.6.4" }),
    );

    release();
    const result = await listPromise;
    expect(result.installed).toEqual([{ name: "zod", version: "4.6.4", latest: null }]);

    // A permanently unparsable file still rejects after its one retry.
    const { service: serviceWithImmediateRetry } = await setup({ listRetryWait: () => Promise.resolve() });
    await writeFile(manifestPath, "{ still not json");
    await expect(serviceWithImmediateRetry.list()).rejects.toThrow();
  });

  test("a throwing onOperation never poisons whenIdle", async () => {
    const loggedMessages: string[] = [];
    const { service, calls } = await setup({
      onOperation: () => {
        throw new Error("event sink is closed");
      },
      log: (message) => {
        loggedMessages.push(message);
      },
    });
    service.install("a@1.0.0");
    service.install("b@1.0.0");
    await service.whenIdle();
    expect(calls.map((call) => call.argv)).toEqual([
      ["add", "--exact", "a@1.0.0"],
      ["add", "--exact", "b@1.0.0"],
    ]);
    expect(loggedMessages).toContain("npm operation event could not be delivered");
  });

  test("a failed registry install with scripts allowed rolls back the trust it added", async () => {
    const manifestPath = join(dir, "data", "packages", "package.json");
    const { service, calls } = await setup({
      settings: () => ({ allowInstallScripts: true, autoInstallTypes: false }),
      respond: async (argv) =>
        String(argv.at(-1)).startsWith("already-trusted")
          ? { exitCode: 1, stdout: "", stderr: "error: ConnectionRefused downloading package manifest x\n" }
          : { exitCode: 1, stdout: "", stderr: "error: ConnectionRefused downloading package manifest y\n" },
    });
    // Seed a package that is already trusted before the failing install.
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.trustedDependencies = ["already-trusted"];
    await writeFile(manifestPath, JSON.stringify(manifest));

    service.install("already-trusted@2.0.0");
    await service.whenIdle();
    expect(JSON.parse(await readFile(manifestPath, "utf8")).trustedDependencies).toEqual(["already-trusted"]);

    service.install("fixture-newly-trusted@1.0.0");
    await service.whenIdle();
    expect(JSON.parse(await readFile(manifestPath, "utf8")).trustedDependencies).toEqual(["already-trusted"]);
    expect(calls.map((call) => call.argv)).toEqual([
      ["add", "--exact", "already-trusted@2.0.0"],
      ["add", "--exact", "fixture-newly-trusted@1.0.0"],
    ]);
  });

  test("a failed pm trust after a successful git install still runs the post-change steps and keeps both logs", async () => {
    const manifestPath = join(dir, "data", "packages", "package.json");
    const { service, calls, ops, afterChange, changed } = await setup({
      settings: () => ({ allowInstallScripts: true, autoInstallTypes: false }),
      respond: async (argv) => {
        if (argv[0] === "add") {
          const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
          manifest.dependencies["from-git"] = "git+https://example.test/from-git.git";
          await writeFile(manifestPath, JSON.stringify(manifest));
          return { exitCode: 0, stdout: "add-ok-marker\n", stderr: "" };
        }
        return { exitCode: 1, stdout: "", stderr: "trust-fail-marker\n" };
      },
    });
    service.install("git+https://example.test/from-git.git");
    await service.whenIdle();
    expect(calls.map((call) => call.argv)).toEqual([
      ["add", "--exact", "git+https://example.test/from-git.git"],
      ["pm", "trust", "from-git"],
    ]);
    const last = ops.at(-1);
    expect(last?.status).toBe("failed");
    expect(last?.error?.log).toContain("add-ok-marker");
    expect(last?.error?.log).toContain("trust-fail-marker");
    expect(afterChange()).toBe(1);
    expect(changed).toHaveLength(1);
  });

  test("a successful install whose output reports blocked postinstalls carries notice scriptBlocked", async () => {
    const { service: okService, ops: okOps } = await setup({
      respond: async () => ({ exitCode: 0, stdout: "", stderr: "Blocked 1 postinstall\n" }),
    });
    okService.install("fixture@1.0.0");
    await okService.whenIdle();
    expect(okOps.at(-1)).toMatchObject({ status: "succeeded", error: null, notice: "scriptBlocked" });

    const { service: failService, ops: failOps } = await setup({
      respond: async () => ({
        exitCode: 1,
        stdout: "",
        stderr: "error: ConnectionRefused downloading package manifest x\n",
      }),
    });
    failService.install("bad@1.0.0");
    await failService.whenIdle();
    expect(failOps.at(-1)).toMatchObject({ status: "failed", notice: null });
  });

  test("failures are classified from the captured Task 9 fixtures", async () => {
    const fixturesDir = join(
      import.meta.dir,
      "..",
      "..",
      "..",
      "..",
      "packages",
      "npm",
      "test",
      "fixtures",
      "bun-output",
    );
    const networkFixture = JSON.parse(await readFile(join(fixturesDir, "add-network.json"), "utf8"));
    const notFoundFixture = JSON.parse(await readFile(join(fixturesDir, "add-not-found.json"), "utf8"));

    const { service: networkService, ops: networkOps } = await setup({
      respond: async () => ({
        exitCode: networkFixture.exitCode,
        stdout: networkFixture.stdout,
        stderr: networkFixture.stderr,
      }),
    });
    networkService.install("fixture-outdated@1.0.0");
    await networkService.whenIdle();
    expect(networkOps.at(-1)?.error?.kind).toBe("network");

    const { service: notFoundService, ops: notFoundOps } = await setup({
      respond: async () => ({
        exitCode: notFoundFixture.exitCode,
        stdout: notFoundFixture.stdout,
        stderr: notFoundFixture.stderr,
      }),
    });
    notFoundService.install("jslab-fixture-missing");
    await notFoundService.whenIdle();
    expect(notFoundOps.at(-1)?.error?.kind).toBe("notFound");
  });

  test("a spawn that rejects fails the operation as unknown without post-change steps", async () => {
    const { service, ops, afterChange, changed } = await setup({
      respond: async () => {
        throw Object.assign(new Error("ENOENT: no such file or directory, posix_spawn '/bun'"), { code: "ENOENT" });
      },
    });
    service.install("fixture@1.0.0");
    await service.whenIdle();
    expect(ops.at(-1)).toMatchObject({ status: "failed", error: { kind: "unknown" } });
    expect(afterChange()).toBe(0);
    expect(changed).toHaveLength(0);
  });

  test("list fills latest from a cached bun outdated that refreshes in the background at most every 10 minutes", async () => {
    let now = 1_000_000;
    const table = "│ Package │ Current │ Update │ Latest │\n│ zod │ 4.0.0 │ 4.0.0 │ 4.6.4 │\n";
    const { service, paths, calls, changed } = await setup({
      now: () => now,
      respond: async (argv) =>
        argv[0] === "outdated" ? { exitCode: 0, stdout: table, stderr: "" } : { exitCode: 0, stdout: "", stderr: "" },
    });
    writeFileSync(
      paths.packagesJson,
      JSON.stringify({
        name: "jslab-packages",
        private: true,
        dependencies: { zod: "4.0.0" },
        trustedDependencies: [],
      }),
    );
    await mkdir(join(paths.packagesNodeModules, "zod"), { recursive: true });
    writeFileSync(join(paths.packagesNodeModules, "zod", "package.json"), JSON.stringify({ version: "4.0.0" }));

    expect((await service.list({ refreshOutdated: true })).installed).toEqual([
      { name: "zod", version: "4.0.0", latest: null },
    ]);
    await service.whenIdle();
    expect(changed.at(-1)).toEqual({
      installed: [{ name: "zod", version: "4.0.0", latest: "4.6.4" }],
      outdatedCheckedAt: 1_000_000,
      outdatedError: null,
    });
    now += 60_000;
    await service.list({ refreshOutdated: true });
    await service.whenIdle();
    expect(calls.filter((call) => call.argv[0] === "outdated")).toHaveLength(1);
    now += 10 * 60_000;
    await service.list({ refreshOutdated: true });
    await service.whenIdle();
    expect(calls.filter((call) => call.argv[0] === "outdated")).toHaveLength(2);
  });

  test("search uses the .npmrc registry and token, parses results, and reports a network failure without the token", async () => {
    const seen: { url: string; authorization: string | null }[] = [];
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      seen.push({ url, authorization: new Headers(init?.headers).get("authorization") });
      if (url.includes("127.0.0.1:9")) {
        // Fix round 1 (M-1): the error message names the URL, but that never includes the token (a header, not
        // part of the URL) or, when the registry itself carries credentials (M-6), the password.
        throw new Error(url.includes("@") ? "ConnectionRefused" : `ConnectionRefused fetching ${url}`);
      }
      return Response.json({ objects: [{ package: { name: "zod", version: "4.6.4", description: "schemas" } }] });
    }) as typeof fetch;
    const { service, paths } = await setup({ fetch: fakeFetch });
    writeFileSync(paths.packagesNpmrc, "registry=http://127.0.0.1:4873\n//127.0.0.1:4873/:_authToken=s3cr3t-token\n");
    expect(await service.search("zod schema")).toEqual({
      results: [{ name: "zod", version: "4.6.4", description: "schemas", weeklyDownloads: null }],
      error: null,
    });
    expect(seen[0]).toEqual({
      url: "http://127.0.0.1:4873/-/v1/search?text=zod%20schema&size=25",
      authorization: "Bearer s3cr3t-token",
    });

    // Fix round 1 (M-1): the dead registry now ALSO has a token, so "not.toContain" is finally a real assertion.
    writeFileSync(
      paths.packagesNpmrc,
      ["registry=http://127.0.0.1:9/", "//127.0.0.1:9/:_authToken=s3cr3t-token"].join(String.fromCharCode(10)),
    );
    const failed = await service.search("zod");
    expect(failed.results).toEqual([]);
    expect(failed.error?.kind).toBe("network");
    expect(failed.error?.log).not.toContain("s3cr3t-token");
    expect(failed.error?.log).toContain("http://127.0.0.1:9/-/v1/search");
    expect(seen[1]).toEqual({
      url: "http://127.0.0.1:9/-/v1/search?text=zod&size=25",
      authorization: "Bearer s3cr3t-token",
    });

    // A registry with no token at all sends no authorization header.
    writeFileSync(paths.packagesNpmrc, "registry=http://127.0.0.1:4873\n");
    await service.search("zod");
    expect(seen[2]?.authorization).toBeNull();

    // Fix round 1 (M-6): a registry URL with embedded credentials never leaks its password into the log.
    writeFileSync(paths.packagesNpmrc, "registry=https://u:hunter2@127.0.0.1:9/\n");
    const failedWithCreds = await service.search("zod");
    expect(failedWithCreds.error?.kind).toBe("network");
    expect(failedWithCreds.error?.log).not.toContain("hunter2");
  });

  test("with automatic types on, an untyped package gets @types/<name> when the registry has it", async () => {
    const seenAccept: string[] = [];
    const { service, paths, calls } = await setup({
      settings: () => ({ allowInstallScripts: false, autoInstallTypes: true }),
      // Fix round 1 (M-1): the fake registry answers 200 for BOTH packages' @types, so fixture-typed's skip can
      // only come from #hasOwnTypes, never from a registry 404.
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        seenAccept.push(new Headers(init?.headers).get("accept") ?? "");
        return url.endsWith("/@types%2ffixture-untyped") || url.endsWith("/@types%2ffixture-typed")
          ? Response.json({ name: "types" })
          : new Response("not found", { status: 404 });
      }) as typeof fetch,
      respond: async (argv) => {
        const spec = String(argv.at(-1));
        const name = spec.includes("@", 1) ? spec.slice(0, spec.lastIndexOf("@")) : spec;
        const manifest = JSON.parse(readFileSync(paths.packagesJson, "utf8"));
        manifest.dependencies[name] = "1.0.0";
        writeFileSync(paths.packagesJson, JSON.stringify(manifest));
        await mkdir(join(paths.packagesNodeModules, name), { recursive: true });
        writeFileSync(
          join(paths.packagesNodeModules, name, "package.json"),
          JSON.stringify(name === "fixture-typed" ? { version: "1.0.0", types: "index.d.ts" } : { version: "1.0.0" }),
        );
        return { exitCode: 0, stdout: `installed ${spec}\n`, stderr: "" };
      },
    });
    writeFileSync(paths.packagesNpmrc, "registry=http://127.0.0.1:4873/\n");
    service.install("fixture-untyped@1.0.0");
    service.install("fixture-typed@1.0.0");
    await service.whenIdle();
    expect(calls.map((call) => call.argv.at(-1))).toEqual([
      "fixture-untyped@1.0.0",
      "fixture-typed@1.0.0",
      "@types/fixture-untyped",
    ]);
    // Fix round 1 (M-3): the existence check requests the abbreviated packument.
    expect(seenAccept).toContain("application/vnd.npm.install-v1+json");
  });

  test("an outdated refresh whose follow-up list throws never poisons whenIdle and can run again", async () => {
    let now = 1_000_000;
    const manifestPath = join(dir, "data", "packages", "package.json");
    let releaseOutdated!: () => void;
    let corruptOnRelease = true;
    const outdatedGate = new Promise<void>((resolve) => {
      releaseOutdated = resolve;
    });
    const { service, calls } = await setup({
      now: () => now,
      listRetryWait: () => Promise.resolve(),
      respond: async (argv) => {
        if (argv[0] === "outdated") {
          await outdatedGate;
          // The refresh's own follow-up list() will find this unparsable and throw (Task 11 I-2).
          if (corruptOnRelease) writeFileSync(manifestPath, "{ not json");
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        return { exitCode: 0, stdout: `installed ${argv.at(-1)}\n`, stderr: "" };
      },
    });

    const first = await service.list({ refreshOutdated: true });
    expect(first.installed).toEqual([]);
    releaseOutdated();
    await expect(service.whenIdle()).resolves.toBeUndefined();

    // Restore a valid manifest and run a healthy install: whenIdle() must resolve again, not inherit the old
    // rejection forever.
    corruptOnRelease = false;
    writeFileSync(
      manifestPath,
      JSON.stringify({ name: "jslab-packages", private: true, dependencies: {}, trustedDependencies: [] }),
    );
    service.install("ok@1.0.0");
    await expect(service.whenIdle()).resolves.toBeUndefined();

    // A second refresh can still start, proving #refreshing was reset by the `finally`, not left stuck.
    now += OUTDATED_TTL_MS;
    await service.list({ refreshOutdated: true });
    await service.whenIdle();
    expect(calls.filter((call) => call.argv[0] === "outdated")).toHaveLength(2);
  });

  test("a burst of refreshOutdated calls runs bun outdated once", async () => {
    const { service, calls } = await setup({
      respond: async (argv) =>
        argv[0] === "outdated" ? { exitCode: 0, stdout: "", stderr: "" } : { exitCode: 0, stdout: "", stderr: "" },
    });
    const first = service.list({ refreshOutdated: true });
    const second = service.list({ refreshOutdated: true });
    await Promise.all([first, second]);
    await service.whenIdle();
    expect(calls.filter((call) => call.argv[0] === "outdated")).toHaveLength(1);
  });

  test("a failed outdated check is cached with its error for the TTL", async () => {
    let now = 1_000_000;
    const { service, calls } = await setup({
      now: () => now,
      respond: async (argv) =>
        argv[0] === "outdated"
          ? { exitCode: 1, stdout: "", stderr: "error: ConnectionRefused downloading package manifest\n" }
          : { exitCode: 0, stdout: "", stderr: "" },
    });
    await service.list({ refreshOutdated: true });
    await service.whenIdle();
    expect((await service.list({ refreshOutdated: false })).outdatedError?.kind).toBe("network");

    now += 60_000;
    await service.list({ refreshOutdated: true });
    await service.whenIdle();
    expect(calls.filter((call) => call.argv[0] === "outdated")).toHaveLength(1);

    now += OUTDATED_TTL_MS;
    await service.list({ refreshOutdated: true });
    await service.whenIdle();
    expect(calls.filter((call) => call.argv[0] === "outdated")).toHaveLength(2);
  });

  test("a successful install clears the outdated cache so the next refresh runs again", async () => {
    let now = 1_000_000;
    const { service, calls } = await setup({
      now: () => now,
      respond: async (argv) =>
        argv[0] === "outdated"
          ? { exitCode: 0, stdout: "", stderr: "" }
          : { exitCode: 0, stdout: "installed ok@1.0.0\n", stderr: "" },
    });
    await service.list({ refreshOutdated: true });
    await service.whenIdle();
    expect(calls.filter((call) => call.argv[0] === "outdated")).toHaveLength(1);

    now += 60_000; // well inside the TTL
    service.install("ok@1.0.0");
    await service.whenIdle();

    await service.list({ refreshOutdated: true });
    await service.whenIdle();
    expect(calls.filter((call) => call.argv[0] === "outdated")).toHaveLength(2);
  });

  test("automatic types does nothing when npm.autoInstallTypes is off", async () => {
    let autoInstallTypes = false;
    let fetchCalls = 0;
    const { service, paths, calls } = await setup({
      settings: () => ({ allowInstallScripts: false, autoInstallTypes }),
      fetch: (async (input: string | URL | Request) => {
        fetchCalls++;
        return String(input).endsWith("/@types%2ffixture-second")
          ? Response.json({ name: "@types/fixture-second" })
          : new Response("not found", { status: 404 });
      }) as typeof fetch,
      respond: async (argv) => {
        const spec = String(argv.at(-1));
        const name = spec.includes("@", 1) ? spec.slice(0, spec.lastIndexOf("@")) : spec;
        const manifest = JSON.parse(readFileSync(paths.packagesJson, "utf8"));
        manifest.dependencies[name] = "1.0.0";
        writeFileSync(paths.packagesJson, JSON.stringify(manifest));
        await mkdir(join(paths.packagesNodeModules, name), { recursive: true });
        writeFileSync(join(paths.packagesNodeModules, name, "package.json"), JSON.stringify({ version: "1.0.0" }));
        return { exitCode: 0, stdout: `installed ${spec}\n`, stderr: "" };
      },
    });
    writeFileSync(paths.packagesNpmrc, "registry=http://127.0.0.1:4873/\n");

    // The setting is read live, as a getter, not captured once at construction.
    service.install("fixture-untyped@1.0.0");
    await service.whenIdle();
    expect(fetchCalls).toBe(0);
    expect(calls.map((call) => call.argv.at(-1))).toEqual(["fixture-untyped@1.0.0"]);

    autoInstallTypes = true;
    service.install("fixture-second@1.0.0");
    await service.whenIdle();
    expect(fetchCalls).toBeGreaterThan(0);
    expect(calls.map((call) => call.argv.at(-1))).toContain("@types/fixture-second");
  });

  test("a scoped search uses the scope's registry and token", async () => {
    const seen: { url: string; authorization: string | null }[] = [];
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      seen.push({ url, authorization: new Headers(init?.headers).get("authorization") });
      return Response.json({ objects: [] });
    }) as typeof fetch;
    const { service, paths } = await setup({ fetch: fakeFetch });
    writeFileSync(
      paths.packagesNpmrc,
      ["@acme:registry=http://127.0.0.1:4873/acme/", "//127.0.0.1:4873/acme/:_authToken=acme-token"].join(
        String.fromCharCode(10),
      ),
    );
    await service.search("@acme/thing");
    expect(seen[0]).toEqual({
      url: "http://127.0.0.1:4873/acme/-/v1/search?text=%40acme%2Fthing&size=25",
      authorization: "Bearer acme-token",
    });
  });

  test("a package whose only 'types' strings are keywords or files entries is not treated as typed", async () => {
    const { service, paths, calls } = await setup({
      settings: () => ({ allowInstallScripts: false, autoInstallTypes: true }),
      fetch: (async (input: string | URL | Request) =>
        String(input).endsWith("/@types%2ffixture-keywords")
          ? Response.json({ name: "@types/fixture-keywords" })
          : new Response("not found", { status: 404 })) as typeof fetch,
      respond: async () => {
        const manifest = JSON.parse(readFileSync(paths.packagesJson, "utf8"));
        manifest.dependencies["fixture-keywords"] = "1.0.0";
        writeFileSync(paths.packagesJson, JSON.stringify(manifest));
        await mkdir(join(paths.packagesNodeModules, "fixture-keywords"), { recursive: true });
        writeFileSync(
          join(paths.packagesNodeModules, "fixture-keywords", "package.json"),
          JSON.stringify({ version: "1.0.0", keywords: ["types"], files: ["dist", "types"] }),
        );
        return { exitCode: 0, stdout: "installed fixture-keywords@1.0.0\n", stderr: "" };
      },
    });
    writeFileSync(paths.packagesNpmrc, "registry=http://127.0.0.1:4873/\n");
    service.install("fixture-keywords@1.0.0");
    await service.whenIdle();
    expect(calls.map((call) => call.argv.at(-1))).toEqual(["fixture-keywords@1.0.0", "@types/fixture-keywords"]);
  });

  test("search returns at most 25 results", async () => {
    const objects = Array.from({ length: 40 }, (_, i) => ({
      package: { name: `pkg-${i}`, version: "1.0.0", description: "" },
    }));
    const { service, paths } = await setup({
      fetch: (async (_input: string | URL | Request) => Response.json({ objects })) as typeof fetch,
    });
    writeFileSync(paths.packagesNpmrc, "registry=http://127.0.0.1:4873/\n");
    const response = await service.search("pkg");
    expect(response.error).toBeNull();
    expect(response.results).toHaveLength(25);
  });

  test("an oversized search body fails as unknown without parsing", async () => {
    const oversized = "x".repeat(MAX_SEARCH_BODY_BYTES + 1024);
    const { service, paths } = await setup({
      fetch: (async (_input: string | URL | Request) =>
        new Response(oversized, { headers: { "content-type": "application/json" } })) as typeof fetch,
    });
    writeFileSync(paths.packagesNpmrc, "registry=http://127.0.0.1:4873/\n");
    const response = await service.search("pkg");
    expect(response.error?.kind).toBe("unknown");
    expect(response.results).toEqual([]);
  });

  test("installing then immediately removing a package never installs its @types", async () => {
    const manifestPath = join(dir, "data", "packages", "package.json");
    let removeDone!: () => void;
    const removeDoneGate = new Promise<void>((resolve) => {
      removeDone = resolve;
    });
    const { service, paths, calls } = await setup({
      settings: () => ({ allowInstallScripts: false, autoInstallTypes: true }),
      // The @types check's registry round trip only resolves once remove("x")'s own respond has run, so the
      // recheck right before installing @types/x always sees the post-remove manifest.
      fetch: (async (_input: string | URL | Request) => {
        await removeDoneGate;
        return Response.json({ name: "@types/x" });
      }) as typeof fetch,
      respond: async (argv) => {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        if (argv[0] === "add") {
          const spec = String(argv.at(-1));
          const name = spec.includes("@", 1) ? spec.slice(0, spec.lastIndexOf("@")) : spec;
          manifest.dependencies[name] = "1.0.0";
          writeFileSync(manifestPath, JSON.stringify(manifest));
          await mkdir(join(paths.packagesNodeModules, name), { recursive: true });
          writeFileSync(join(paths.packagesNodeModules, name, "package.json"), JSON.stringify({ version: "1.0.0" }));
          return { exitCode: 0, stdout: `installed ${spec}\n`, stderr: "" };
        }
        if (argv[0] === "remove") {
          delete manifest.dependencies[String(argv[1])];
          writeFileSync(manifestPath, JSON.stringify(manifest));
          removeDone();
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    writeFileSync(paths.packagesNpmrc, "registry=http://127.0.0.1:4873/\n");
    service.install("x@1.0.0");
    service.remove("x");
    await service.whenIdle();
    expect(calls.map((call) => call.argv.at(-1))).toEqual(["x@1.0.0", "x"]);
  });
});
