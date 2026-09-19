import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { e2eBunCacheDir, resolveAppPaths, runnerEnvironment } from "../src/main/app-paths";

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
      packagesDir: "/Users/me/Library/Application Support/dev.jslab.app/stable/packages",
      packagesJson: "/Users/me/Library/Application Support/dev.jslab.app/stable/packages/package.json",
      packagesNpmrc: "/Users/me/Library/Application Support/dev.jslab.app/stable/packages/.npmrc",
      npmHome: "/Users/me/Library/Application Support/dev.jslab.app/stable/npm-home",
      vendorCacheDir: "/Users/me/Library/Application Support/dev.jslab.app/stable/cache/vendor",
      envFile: "/Users/me/Library/Application Support/dev.jslab.app/stable/env.json",
      snippetsFile: "/Users/me/Library/Application Support/dev.jslab.app/stable/snippets.json",
      // Spec §14.3: the AI chat conversation, in its own `ai/` folder as the spec writes the path.
      conversationFile: "/Users/me/Library/Application Support/dev.jslab.app/stable/ai/conversation.json",
      socketPath: "/Users/me/Library/Application Support/dev.jslab.app/stable/jslab.sock",
      screenshotsDir: "/Users/me/Library/Application Support/dev.jslab.app/stable/e2e-screenshots",
      themesDir: "/Users/me/Library/Application Support/dev.jslab.app/stable/themes",
      runnerBootstrap: "/Applications/JSLab.app/Contents/Resources/app/runner/bootstrap.js",
      // M4 §5.12: shipped beside the Bun runner's bootstrap, by the same `dist/runner` → `runner` copy rule.
      webRunnerBootstrap: "/Applications/JSLab.app/Contents/Resources/app/runner/web-bootstrap.js",
      transformWorker: "/Applications/JSLab.app/Contents/Resources/app/workers/transform-worker.js",
      // Spec §17: staged into the bundle by hutch.config.ts and copied to Resources/app/locales, so Main
      // reads the very files apps/ui/src/i18n/locales/ ships.
      localesDir: "/Applications/JSLab.app/Contents/Resources/app/locales",
      // M6: Help → About → Open-Source Notices…. Staged into the bundle by hutch.config.ts and copied to
      // Resources/app by electrobun.config.ts's `"dist/THIRD-PARTY-NOTICES.md": "THIRD-PARTY-NOTICES.md"`,
      // so this is the file a BUILT app really opens -- not a path guessed beside the sources.
      noticesFile: "/Applications/JSLab.app/Contents/Resources/app/THIRD-PARTY-NOTICES.md",
      bunBinary: "/Applications/JSLab.app/Contents/MacOS/bun",
      // Spec §16.1: the symlink target Help -> Install `jslab` Command… creates.
      cliBinary: "/Applications/JSLab.app/Contents/Resources/app/bin/jslab",
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
    expect(resolveAppPaths({ ...input, env: { JSLAB_CLI_BINARY: "/src/jslab" } }).cliBinary).toBe("/src/jslab");
    expect(resolveAppPaths({ ...input, env: { JSLAB_NOTICES_FILE: "/src/NOTICES.md" } }).noticesFile).toBe(
      "/src/NOTICES.md",
    );
  });

  test("JSLAB_USER_DATA relocates every data path", () => {
    const paths = resolveAppPaths({ ...input, env: { JSLAB_USER_DATA: "/tmp-e2e/u1" } });
    expect([paths.dataDir, paths.runLock, paths.socketPath, paths.themesDir]).toEqual([
      "/tmp-e2e/u1",
      "/tmp-e2e/u1/run.lock",
      "/tmp-e2e/u1/jslab.sock",
      "/tmp-e2e/u1/themes",
    ]);
  });

  test("e2eBunCacheDir keeps E2E npm off the user's Bun cache", () => {
    expect(e2eBunCacheDir({ JSLAB_E2E_BUN_CACHE_DIR: "/x" }, "/data")).toBeUndefined();
    expect(e2eBunCacheDir({ JSLAB_E2E: "1", JSLAB_E2E_BUN_CACHE_DIR: "/x" }, "/data")).toBe("/x");
    expect(e2eBunCacheDir({ JSLAB_E2E: "1" }, "/data")).toBe(join("/data", "e2e-bun-cache"));
  });
});

describe("runnerEnvironment", () => {
  test("sets JSLAB and NODE_PATH, drops undefined values and JSLab overrides", () => {
    const paths = resolveAppPaths(input);
    expect(
      runnerEnvironment(paths, {
        base: { PATH: "/usr/bin", EMPTY: undefined, JSLAB_BUN_PATH: "/x", NODE_PATH: "/old" },
      }),
    ).toEqual({
      PATH: "/usr/bin",
      JSLAB: "1",
      NODE_PATH: paths.packagesNodeModules,
    });
  });

  test("BUN_OPTIONS is dropped from every layer", () => {
    const paths = resolveAppPaths(input);
    const env = runnerEnvironment(paths, {
      base: { BUN_OPTIONS: "--preload ./login.js", FROM_LOGIN: "1" },
      variables: { BUN_OPTIONS: "--preload ./env-json.js", FROM_ENV_JSON: "1" },
      dotenv: { BUN_OPTIONS: "--env-file=.env.local", FROM_DOTENV: "1" },
    });
    expect(Object.hasOwn(env, "BUN_OPTIONS")).toBe(false);
    expect(env).toMatchObject({ FROM_LOGIN: "1", FROM_ENV_JSON: "1", FROM_DOTENV: "1" });
  });

  test("keys that are empty or contain = or NUL are dropped from every layer", () => {
    const paths = resolveAppPaths(input);
    const NUL = String.fromCharCode(0);
    const env = runnerEnvironment(paths, {
      base: { [`BAD${NUL}KEY`]: "x", OK_C: "3" },
      variables: { "BUN_OPTIONS=--preload": "./p.js", OK_A: "1" },
      dotenv: { "": "x", OK_B: "2" },
    });
    expect(env).toEqual({ OK_C: "3", OK_A: "1", OK_B: "2", JSLAB: "1", NODE_PATH: paths.packagesNodeModules });
    for (const key of Object.keys(env)) {
      expect(key).not.toBe("");
      expect(key.includes("=")).toBe(false);
      expect(key.includes(NUL)).toBe(false);
    }
  });
});
