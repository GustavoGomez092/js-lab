import type { Locale } from "@jslab/shared";

export const DEV_SERVER_URL = "http://localhost:5173";
export const BUILT_VIEW_URL = "views://mainview/index.html";
export const DEV_SERVER_TIMEOUT_MS = 500;

/**
 * The main view gets the full RPC bridge, so it loads a Vite dev server only when a developer opts in with
 * JSLAB_DEV_SERVER=1 on the dev channel (another project's server on port 5173 is never trusted), and a server that
 * accepts but never answers can't hang startup (final review M2).
 */
export async function resolveMainViewUrl(input: {
  channel: string;
  env: Record<string, string | undefined>;
  probe(url: string, signal: AbortSignal): Promise<unknown>;
  timeoutMs?: number;
}): Promise<string> {
  if (input.channel !== "dev" || input.env.JSLAB_DEV_SERVER !== "1") return BUILT_VIEW_URL;
  const signal = AbortSignal.timeout(input.timeoutMs ?? DEV_SERVER_TIMEOUT_MS);
  const aborted = new Promise<never>((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  try {
    await Promise.race([input.probe(DEV_SERVER_URL, signal), aborted]);
    return DEV_SERVER_URL;
  } catch {
    return BUILT_VIEW_URL;
  }
}

/**
 * The locale a window opens in, carried on the URL (spec §17). The view needs it synchronously, before its first
 * render -- its string table is imported at module scope across the UI, long before any bootstrap RPC resolves -- and
 * a query parameter is the only channel already present when the bundle's first line runs. It is also why changing
 * the language needs a restart: the URL is fixed when the window is created.
 *
 * `views://` is not a registered scheme for `new URL`, so this edits the query textually rather than round-tripping
 * through URL, and replaces any existing `lng` instead of appending a second one.
 */
export function withLocale(url: string, locale: Locale): string {
  const [base, query = ""] = url.split("?");
  const parameters = query
    .split("&")
    .filter((entry) => entry !== "" && !entry.startsWith("lng="))
    .concat(`lng=${locale}`);
  // A dev-server origin has no path of its own ("http://localhost:5173"); give it the root path so the
  // `${origin}/*` navigation rule matches.
  const path = base?.includes("/", base.indexOf("//") + 2) ? base : `${base}/`;
  return `${path}?${parameters.join("&")}`;
}
