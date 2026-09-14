import { describe, expect, test } from "bun:test";
import { resolveAppPaths, runnerEnvironment } from "../src/main/app-paths";

const input = {
  resourcesFolder: "/Applications/JSLab.app/Contents/Resources",
  userData: "/Users/me/Library/Application Support/dev.jslab.app/stable",
  execPath: "/Applications/JSLab.app/Contents/MacOS/bun",
  env: {},
};

describe("resolveAppPaths", () => {
  test("derives data and bundle locations", () => {
    expect(resolveAppPaths(input)).toEqual({
      dataDir: "/Users/me/Library/Application Support/dev.jslab.app/stable",
      runsDir: "/Users/me/Library/Application Support/dev.jslab.app/stable/runs",
      runLock: "/Users/me/Library/Application Support/dev.jslab.app/stable/run.lock",
      packagesNodeModules: "/Users/me/Library/Application Support/dev.jslab.app/stable/packages/node_modules",
      socketPath: "/Users/me/Library/Application Support/dev.jslab.app/stable/jslab.sock",
      screenshotsDir: "/Users/me/Library/Application Support/dev.jslab.app/stable/e2e-screenshots",
      runnerBootstrap: "/Applications/JSLab.app/Contents/Resources/app/runner/bootstrap.js",
      transformWorker: "/Applications/JSLab.app/Contents/Resources/app/workers/transform-worker.js",
      bunBinary: "/Applications/JSLab.app/Contents/MacOS/bun",
    });
  });

  test("honors development overrides", () => {
    const paths = resolveAppPaths({
      ...input,
      env: {
        JSLAB_RUNNER_BOOTSTRAP: "/src/bootstrap.ts",
        JSLAB_TRANSFORM_WORKER: "/src/worker.ts",
        JSLAB_BUN_PATH: "/bin/bun",
      },
    });
    expect(paths.runnerBootstrap).toBe("/src/bootstrap.ts");
    expect(paths.transformWorker).toBe("/src/worker.ts");
    expect(paths.bunBinary).toBe("/bin/bun");
  });

  test("JSLAB_USER_DATA relocates every data path", () => {
    const paths = resolveAppPaths({ ...input, env: { JSLAB_USER_DATA: "/tmp-e2e/u1" } });
    expect([paths.dataDir, paths.runLock, paths.socketPath]).toEqual([
      "/tmp-e2e/u1",
      "/tmp-e2e/u1/run.lock",
      "/tmp-e2e/u1/jslab.sock",
    ]);
  });
});

describe("runnerEnvironment", () => {
  test("sets JSLAB and NODE_PATH, drops undefined values and JSLab overrides", () => {
    const paths = resolveAppPaths(input);
    expect(
      runnerEnvironment(paths, { PATH: "/usr/bin", EMPTY: undefined, JSLAB_BUN_PATH: "/x", NODE_PATH: "/old" }),
    ).toEqual({
      PATH: "/usr/bin",
      JSLAB: "1",
      NODE_PATH: paths.packagesNodeModules,
    });
  });
});
