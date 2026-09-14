import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { npmEnvironment, resolveBunCacheDir } from "../src/environment";

/** A fake user home (built with `join`, so no literal home path appears in the source). */
const USER_HOME = join("/Users", "tester");

describe("npm environment (M0-S8, spec §11.3)", () => {
  test("strips user npm and Bun config variables, JSLab variables and XDG_CONFIG_HOME, and sets the isolated HOME and cache", () => {
    const env = npmEnvironment({
      base: {
        PATH: "/usr/bin:/bin",
        HOME: USER_HOME,
        BUN_CONFIG_REGISTRY: "http://evil.test/",
        bun_config_verbose: "1",
        NPM_CONFIG_USERCONFIG: `${USER_HOME}/.npmrc`,
        npm_config_registry: "http://evil.test/",
        Npm_Config_Cache: "/x",
        XDG_CONFIG_HOME: `${USER_HOME}/.config`,
        BUN_INSTALL_CACHE_DIR: "/somewhere/else",
        JSLAB_USER_DATA: "/data",
        LANG: "en_US.UTF-8",
        EMPTY: undefined,
      },
      npmHome: "/data/npm-home",
      bunCacheDir: `${USER_HOME}/.bun/install/cache`,
    });
    expect(env).toEqual({
      PATH: "/usr/bin:/bin",
      LANG: "en_US.UTF-8",
      HOME: "/data/npm-home",
      BUN_INSTALL_CACHE_DIR: `${USER_HOME}/.bun/install/cache`,
      NO_COLOR: "1",
    });
  });

  test("resolves the user's Bun cache before HOME is overridden", () => {
    expect(
      resolveBunCacheDir({ BUN_INSTALL_CACHE_DIR: "/c", XDG_CACHE_HOME: "/x", BUN_INSTALL: "/b" }, USER_HOME),
    ).toBe("/c");
    expect(resolveBunCacheDir({ XDG_CACHE_HOME: "/x/", BUN_INSTALL: "/b" }, USER_HOME)).toBe("/b/install/cache");
    expect(resolveBunCacheDir({ XDG_CACHE_HOME: "/x/" }, USER_HOME)).toBe("/x/.bun/install/cache");
    expect(resolveBunCacheDir({ BUN_INSTALL: "/b" }, USER_HOME)).toBe("/b/install/cache");
    expect(resolveBunCacheDir({}, USER_HOME)).toBe(`${USER_HOME}/.bun/install/cache`);
  });

  test("git-over-SSH specs keep the agent socket and an explicit ssh command, never the real HOME (M0-S8 follow-up)", () => {
    const env = npmEnvironment({
      base: { HOME: USER_HOME, SSH_AUTH_SOCK: "/tmp-ssh/agent.sock", GIT_SSH_COMMAND: "ssh -i ~/.ssh/k" },
      npmHome: "/data/npm-home",
      bunCacheDir: "/cache",
    });
    expect([env.SSH_AUTH_SOCK, env.GIT_SSH_COMMAND, env.HOME]).toEqual([
      "/tmp-ssh/agent.sock",
      "ssh -i ~/.ssh/k",
      "/data/npm-home",
    ]);
  });
});
