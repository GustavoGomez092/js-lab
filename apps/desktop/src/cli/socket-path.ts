import { join } from "node:path";
import { MAX_SOCKET_PATH_BYTES } from "../main/cli/ndjson";

export const APP_BUNDLE_ID = "dev.jslab.app";

/** Electrobun lays userData out as `<appData>/dev.jslab.app/<channel>` (spec §4.5). */
export const CLI_CHANNELS = ["stable", "canary", "dev"] as const;

/**
 * Where `jslab` looks for `jslab.sock` (spec §16.3). The binary can't ask Electrobun for `Utils.paths.userData`, so
 * it reconstructs the same layout — with the two overrides a scripted launch needs, matching `resolveAppPaths`'s own
 * `JSLAB_USER_DATA`. Paths macOS could never bind (`sun_path` is 104 bytes including the NUL) are dropped here, so
 * the caller never reports a connection failure that was really a too-long path.
 */
export function candidateSocketPaths(env: Record<string, string | undefined>, home: string): string[] {
  const fits = (path: string) => Buffer.byteLength(path) <= MAX_SOCKET_PATH_BYTES;
  if (env.JSLAB_SOCKET) return [env.JSLAB_SOCKET].filter(fits);
  if (env.JSLAB_USER_DATA) return [join(env.JSLAB_USER_DATA, "jslab.sock")].filter(fits);
  const preferred = CLI_CHANNELS.find((channel) => channel === env.JSLAB_CHANNEL);
  const order = preferred ? [preferred, ...CLI_CHANNELS.filter((channel) => channel !== preferred)] : CLI_CHANNELS;
  const support = join(home, "Library", "Application Support", APP_BUNDLE_ID);
  return order.map((channel) => join(support, channel, "jslab.sock")).filter(fits);
}
