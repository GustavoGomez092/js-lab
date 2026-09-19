import type { Log } from "../rpc/validate";
import { strings } from "../strings";
import type { SocketMethod } from "./ndjson";
import { type SocketServer, startSocketServer } from "./socket-server";

/**
 * Starts the jslab CLI socket (spec §16.3), which every launch serves — not only `JSLAB_E2E=1` ones. It must never
 * take startup down: `startSocketServer` throws rather than steal a socket another instance is listening on, and
 * that is exactly what the *second* JSLab a user opens finds. Unhandled, that throw reaches `errorPolicy.fail` in
 * index.ts and exits 1 (spec §20) — so opening JSLab twice would look like the app refusing to launch. A second
 * instance loses the CLI socket and says so in the log instead; everything else about it works normally, and the
 * `jslab` command keeps reaching the instance that owns the socket.
 *
 * Extracted from index.ts's wiring so this rule has its own test, the same reason `dispatchMenuAction` (menu.ts)
 * lives outside index.ts.
 */
export async function startCliSocket(options: {
  path: string;
  methods: Record<string, SocketMethod>;
  log: Log;
}): Promise<SocketServer | null> {
  try {
    return await startSocketServer(options);
  } catch (error) {
    options.log(strings.log.cliSocketFailed, String(error));
    return null;
  }
}
