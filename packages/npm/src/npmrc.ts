import { MAX_NPMRC_CHARS } from "@jslab/rpc-schema";
import { DEFAULT_REGISTRY } from "@jslab/shared";

export type NpmrcConfig = ReadonlyMap<string, string>;
export type EnvLike = Record<string, string | undefined>;

/**
 * Parses `<packages>/.npmrc` (spec §11.5). A later key wins; comments start with `;` or `#`.
 *
 * Text over `MAX_NPMRC_CHARS` parses to an empty config, the same defensive cap its sibling `parseDotenv`
 * carries. This is a backstop, not the real guard: Main's only production caller reads the file through
 * `readBoundedText`, which throws before text this large can ever reach here. That ordering matters, because an
 * empty config is what makes `registryFor` fall back to the public registry — so if this cap were the *only*
 * bound, an oversized `.npmrc` would silently retarget a private registry, exactly the failure FR-12 fixed.
 */
export function parseNpmrc(text: string): Map<string, string> {
  const config = new Map<string, string>();
  if (text.length > MAX_NPMRC_CHARS) return config;
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(";") || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0])
      value = value.slice(1, -1);
    config.delete(key);
    config.set(key, value);
  }
  return config;
}

export function expandNpmrcValue(value: string, env: EnvLike): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => env[name] ?? "");
}

const withSlash = (url: string) => (url.endsWith("/") ? url : `${url}/`);

/**
 * FR-5: case-folds only the `//host[:port]` authority of a schemeless `//host/path` string, leaving the path
 * (which can be case-sensitive on a registry) untouched.
 */
const foldAuthority = (schemeless: string): string => {
  const match = /^(\/\/[^/]*)([\s\S]*)$/.exec(schemeless);
  if (!match) return schemeless;
  return `${(match[1] ?? "").toLowerCase()}${match[2] ?? ""}`;
};

export function registryFor(config: NpmrcConfig, packageName: string | null, env: EnvLike): string {
  const scope = packageName?.startsWith("@") ? packageName.split("/")[0] : null;
  const scoped = scope ? config.get(`${scope}:registry`) : undefined;
  const chosen = scoped ?? config.get("registry");
  return withSlash(chosen ? expandNpmrcValue(chosen, env) : DEFAULT_REGISTRY);
}

/** The `_authToken` whose `//host/path/` key is the longest prefix of the registry URL (without its protocol). */
export function authTokenFor(config: NpmrcConfig, registryUrl: string, env: EnvLike): string | null {
  // FR-5: fold scheme and host/port case before comparing, on both sides, so `https://NPM.ACME.TEST/` still
  // matches a `//npm.acme.test/:_authToken` key. The path segment is never folded -- registry paths can be
  // case-sensitive.
  const target = foldAuthority(withSlash(registryUrl.replace(/^https?:/i, "")));
  let best: { length: number; token: string } | null = null;
  for (const [key, value] of config) {
    if (!key.endsWith(":_authToken") || !key.startsWith("//")) continue;
    const prefix = foldAuthority(withSlash(key.slice(0, -":_authToken".length)));
    if (!target.startsWith(prefix)) continue;
    if (!best || prefix.length > best.length) best = { length: prefix.length, token: expandNpmrcValue(value, env) };
  }
  return best?.token || null;
}

/**
 * Fix round 1 (M-6): a `.npmrc` registry may embed `user:pass@host`. This strips that userinfo before the URL
 * reaches a log or error, so a leaked debug report never contains a password. Non-URLs pass through unchanged.
 */
export function redactRegistryUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (!parsed.username && !parsed.password) return url;
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return url;
  }
}
