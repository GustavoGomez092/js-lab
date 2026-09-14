/** Node built-ins (spec §11.4: never offered for install). Bun resolves them before any package. */
export const NODE_BUILTINS: ReadonlySet<string> = new Set([
  "assert",
  "async_hooks",
  "buffer",
  "child_process",
  "cluster",
  "console",
  "constants",
  "crypto",
  "dgram",
  "diagnostics_channel",
  "dns",
  "domain",
  "events",
  "fs",
  "http",
  "http2",
  "https",
  "inspector",
  "module",
  "net",
  "os",
  "path",
  "perf_hooks",
  "process",
  "punycode",
  "querystring",
  "readline",
  "repl",
  "stream",
  "string_decoder",
  "sys",
  "timers",
  "tls",
  "trace_events",
  "tty",
  "url",
  "util",
  "v8",
  "vm",
  "wasi",
  "worker_threads",
  "zlib",
]);

const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const URL_LIKE = /^[a-z][a-z0-9+.-]*:/i;

/**
 * The package a bare import specifier names (spec §11.4): `@a/b/c` → `@a/b`, `lodash/fp` → `lodash`. Relative,
 * absolute, `#` subpath imports, URL-like (`node:`, `bun:`, `https:`), `bun` and Node built-ins give null.
 */
export function packageNameFromSpecifier(specifier: string): string | null {
  const spec = specifier.trim();
  if (!spec || spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("#") || URL_LIKE.test(spec)) return null;
  if (spec === "bun") return null;
  const parts = spec.split("/");
  const name = spec.startsWith("@") ? (parts[1] ? `${parts[0]}/${parts[1]}` : null) : (parts[0] ?? null);
  if (!name || !PACKAGE_NAME.test(name)) return null;
  if (!name.startsWith("@") && NODE_BUILTINS.has(name)) return null;
  return name;
}

export type InstallSpec =
  | { kind: "registry"; name: string; range: string | null; raw: string }
  | { kind: "git" | "tarball" | "path"; name: null; raw: string };

/** What the NPM sheet's input installs (spec §11.2): name@version/range, a git URL, a tarball URL or a local path. */
export function parseInstallSpec(input: string): InstallSpec | null {
  const raw = input.trim();
  if (!raw || /\s/.test(raw) || raw.startsWith("-")) return null;
  if (/^(?:git\+|git:\/\/|github:|gitlab:|bitbucket:)/.test(raw) || /\.git(?:#.*)?$/.test(raw)) {
    return { kind: "git", name: null, raw };
  }
  if (/^https?:\/\//.test(raw)) return { kind: "tarball", name: null, raw };
  if (raw.startsWith("file:") || raw.startsWith(".") || raw.startsWith("/")) return { kind: "path", name: null, raw };
  if (/^[\w.-]+\/[\w.-]+(?:#.*)?$/.test(raw) && !raw.startsWith("@")) return { kind: "git", name: null, raw };
  const at = raw.startsWith("@") ? raw.indexOf("@", 1) : raw.indexOf("@");
  const name = at < 0 ? raw : raw.slice(0, at);
  const range = at < 0 ? null : raw.slice(at + 1) || null;
  if (!PACKAGE_NAME.test(name)) return null;
  return { kind: "registry", name, range, raw };
}

/** `zod` → `@types/zod`, `@scope/x` → `@types/scope__x`; an `@types` package has none. */
export function typesPackageName(name: string): string | null {
  if (name.startsWith("@types/")) return null;
  return name.startsWith("@") ? `@types/${name.slice(1).replace("/", "__")}` : `@types/${name}`;
}
