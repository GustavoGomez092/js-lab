import { describe, expect, test } from "bun:test";
import { resolveAppPaths, runnerEnvironment } from "../src/main/app-paths";
import { buildMenu, commandForMenuAction, type MenuItem } from "../src/main/menu";

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

describe("menu", () => {
  const flatten = (items: MenuItem[]): MenuItem[] => items.flatMap((item) => [item, ...flatten(item.submenu ?? [])]);

  test("every action maps to a command", () => {
    const actions = flatten(buildMenu()).flatMap((item) => (item.action ? [item.action] : []));
    expect(actions.map(commandForMenuAction)).toEqual([
      "output.clear",
      "editor.clear",
      "run.start",
      "run.stop",
      "run.kill",
    ]);
  });

  test("keeps native clipboard roles and registers no accelerators", () => {
    const items = flatten(buildMenu());
    for (const role of ["undo", "redo", "cut", "copy", "paste", "selectAll", "quit"]) {
      expect(items.some((item) => item.role === role)).toBe(true);
    }
    expect(items.some((item) => item.accelerator)).toBe(false);
  });

  test("unknown actions are ignored", () => {
    expect(commandForMenuAction("jslab:unknown")).toBeNull();
  });
});
