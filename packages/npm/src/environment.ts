import type { EnvLike } from "./npmrc";

const STRIPPED_KEYS = new Set(["HOME", "BUN_INSTALL_CACHE_DIR", "XDG_CONFIG_HOME"]);
const STRIPPED_PREFIXES = ["bun_config_", "npm_config_"];

const trimSlash = (path: string) => path.replace(/\/+$/, "");

/**
 * The user's Bun package cache, resolved from the login-shell environment before HOME is overridden (spec §11.3):
 * BUN_INSTALL_CACHE_DIR, then $XDG_CACHE_HOME/.bun/install/cache, then $BUN_INSTALL/install/cache, then the real home.
 * Task 9 checks this order against `bun pm cache` on the bundled Bun.
 */
export function resolveBunCacheDir(env: EnvLike, realHome: string): string {
  if (env.BUN_INSTALL_CACHE_DIR) return env.BUN_INSTALL_CACHE_DIR;
  if (env.XDG_CACHE_HOME) return `${trimSlash(env.XDG_CACHE_HOME)}/.bun/install/cache`;
  if (env.BUN_INSTALL) return `${trimSlash(env.BUN_INSTALL)}/install/cache`;
  return `${trimSlash(realHome)}/.bun/install/cache`;
}

/**
 * The environment of every npm operation (M0-S8 Decision, spec §11.3). HOME points at the app-owned, empty npm-home,
 * so the user's ~/.npmrc never applies; npm and Bun config variables are stripped, so `<packages>/.npmrc` is the only
 * source of registry and auth settings. SSH_AUTH_SOCK and GIT_SSH_COMMAND pass through for git-over-SSH specs.
 */
export function npmEnvironment(input: { base: EnvLike; npmHome: string; bunCacheDir: string }): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.base)) {
    if (value === undefined || key.startsWith("JSLAB_") || STRIPPED_KEYS.has(key)) continue;
    const lower = key.toLowerCase();
    if (STRIPPED_PREFIXES.some((prefix) => lower.startsWith(prefix))) continue;
    env[key] = value;
  }
  env.HOME = input.npmHome;
  env.BUN_INSTALL_CACHE_DIR = input.bunCacheDir;
  env.NO_COLOR = "1";
  return env;
}
