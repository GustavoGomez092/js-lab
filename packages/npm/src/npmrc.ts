import { DEFAULT_REGISTRY } from "@jslab/shared";

export type NpmrcConfig = ReadonlyMap<string, string>;
export type EnvLike = Record<string, string | undefined>;

/** Parses `<packages>/.npmrc` (spec §11.5). A later key wins; comments start with `;` or `#`. */
export function parseNpmrc(text: string): Map<string, string> {
  const config = new Map<string, string>();
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

export function registryFor(config: NpmrcConfig, packageName: string | null, env: EnvLike): string {
  const scope = packageName?.startsWith("@") ? packageName.split("/")[0] : null;
  const scoped = scope ? config.get(`${scope}:registry`) : undefined;
  const chosen = scoped ?? config.get("registry");
  return withSlash(chosen ? expandNpmrcValue(chosen, env) : DEFAULT_REGISTRY);
}

/** The `_authToken` whose `//host/path/` key is the longest prefix of the registry URL (without its protocol). */
export function authTokenFor(config: NpmrcConfig, registryUrl: string, env: EnvLike): string | null {
  const target = withSlash(registryUrl.replace(/^https?:/, ""));
  let best: { length: number; token: string } | null = null;
  for (const [key, value] of config) {
    if (!key.endsWith(":_authToken") || !key.startsWith("//")) continue;
    const prefix = withSlash(key.slice(0, -":_authToken".length));
    if (!target.startsWith(prefix)) continue;
    if (!best || prefix.length > best.length) best = { length: prefix.length, token: expandNpmrcValue(value, env) };
  }
  return best?.token || null;
}
