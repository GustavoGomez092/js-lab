import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAppPaths } from "../../src/main/app-paths";
import { mergeLoginEnv } from "../../src/main/platform/login-shell-env";
import { createRunnerConfig } from "../../src/main/runs/runner-config";

const LF = String.fromCharCode(10);

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jslab-runner-config-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const pathsIn = (root: string) =>
  resolveAppPaths({ resourcesFolder: "/R", userData: join(root, "data"), execPath: "/bun", env: {} });

describe("runner spawn configuration (spec §5.3)", () => {
  test("layers login shell < env.json < .env < JSLAB=1, drops JSLAB_* and puts the WD's node_modules first", () => {
    const paths = pathsIn("/x");
    const read: string[] = [];
    const configFor = createRunnerConfig({
      paths,
      baseEnv: () => ({
        PATH: "/usr/bin",
        SHARED: "login",
        ONLY_LOGIN: "1",
        JSLAB_USER_DATA: "/data",
        UNSET: undefined,
      }),
      envVars: () => ({ SHARED: "env.json", ONLY_ENV: "1", JSLAB: "0", JSLAB_EVIL: "1" }),
      workingDirectory: () => "/work/api",
      isDirectory: (path) => path === "/work/api",
      readText: (path) => {
        read.push(path);
        return `SHARED=dotenv${LF}ONLY_DOTENV=1${LF}NODE_PATH=/evil${LF}`;
      },
    });
    const config = configFor("t1");
    expect(read).toEqual(["/work/api/.env"]);
    expect(config.cwd).toBe("/work/api");
    expect(config.env).toEqual({
      PATH: "/usr/bin",
      SHARED: "dotenv",
      ONLY_LOGIN: "1",
      ONLY_ENV: "1",
      ONLY_DOTENV: "1",
      JSLAB: "1",
      NODE_PATH: `/work/api/node_modules:${paths.packagesNodeModules}`,
      PWD: "/work/api",
    });
  });

  test("without a working directory the data folder is the cwd and no .env is read", () => {
    const paths = pathsIn("/x");
    const configFor = createRunnerConfig({
      paths,
      baseEnv: () => ({ PATH: "/usr/bin" }),
      envVars: () => ({ A: "1" }),
      workingDirectory: () => null,
      readText: () => {
        throw new Error("no .env without a WD");
      },
    });
    expect(configFor("t1")).toMatchObject({
      cwd: paths.dataDir,
      env: { A: "1", JSLAB: "1", NODE_PATH: paths.packagesNodeModules },
    });
  });

  test("a missing WD falls back to the data folder, and a .env over 1 MB is ignored", async () => {
    const paths = pathsIn(dir);
    const wd = join(dir, "wd");
    await mkdir(wd, { recursive: true });
    await writeFile(join(wd, ".env"), `BIG=${"x".repeat(1024 * 1024)}${LF}`);
    let current: string | null = join(dir, "missing");
    const configFor = createRunnerConfig({
      paths,
      baseEnv: () => ({}),
      envVars: () => ({}),
      workingDirectory: () => current,
    });
    expect(configFor("t1").cwd).toBe(paths.dataDir);
    current = wd;
    const config = configFor("t1");
    expect(config.cwd).toBe(wd);
    expect(config.env.BIG).toBeUndefined();
  });

  test("a FIFO .env in the working directory is ignored without blocking", async () => {
    const paths = pathsIn(dir);
    const wd = join(dir, "fifo-wd");
    const fifoPath = join(wd, ".env");
    await mkdir(wd, { recursive: true });
    try {
      expect(await Bun.spawn(["mkfifo", fifoPath]).exited).toBe(0);
      const configFor = createRunnerConfig({
        paths,
        baseEnv: () => ({}),
        envVars: () => ({}),
        workingDirectory: () => wd,
      });
      const config = configFor("t1");
      expect(config.cwd).toBe(wd);
      expect(Object.keys(config.env).filter((key) => !["JSLAB", "NODE_PATH", "PWD"].includes(key))).toEqual([]);
    } finally {
      await rm(fifoPath, { force: true });
    }
  }, 5000);

  test("runner PWD is the runner cwd, and the login shell's PWD/OLDPWD/SHLVL/_ are dropped", () => {
    const paths = pathsIn("/x");
    let wd: string | null = "/work/api";
    const configFor = createRunnerConfig({
      paths,
      baseEnv: () =>
        mergeLoginEnv({ HOME: "/h" }, { PWD: "/", OLDPWD: "/x", SHLVL: "3", _: "/usr/bin/env", PATH: "/opt/bin" }),
      envVars: () => ({}),
      workingDirectory: () => wd,
      isDirectory: (path) => path === "/work/api",
      readText: () => null,
    });
    const config = configFor("t1");
    expect(config.cwd).toBe("/work/api");
    expect(config.env.PWD).toBe("/work/api");
    expect(config.env.OLDPWD).toBeUndefined();
    expect(config.env.SHLVL).toBeUndefined();
    expect(config.env._).toBeUndefined();
    expect(config.env.PATH).toBe("/opt/bin");
    expect(config.env.HOME).toBe("/h");
    wd = null;
    expect(configFor("t1").env.PWD).toBe(paths.dataDir);
  });
});
