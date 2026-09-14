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
