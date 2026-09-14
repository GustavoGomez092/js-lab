import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OperationQueue } from "@jslab/npm";
import type { NpmListResult, NpmOperation } from "@jslab/rpc-schema";
import { resolveAppPaths } from "../../src/main/app-paths";
import { NpmService, type NpmServiceDeps } from "../../src/main/services/npm-service";
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
});
