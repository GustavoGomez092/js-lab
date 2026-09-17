import { existsSync } from "node:fs";
import { LineBuffer, MAX_SOCKET_PATH_BYTES } from "../main/cli/ndjson";
import { APP_BUNDLE_ID } from "./socket-path";

export interface CliConnection {
  call(method: string, params: unknown, timeoutMs?: number): Promise<Record<string, unknown>>;
  close(): void;
}

export interface CliTransport {
  /** Resolves with a connection, or null when nothing is listening on `path`. Never throws. */
  connect(path: string): Promise<CliConnection | null>;
  launch(): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
  /**
   * Whether a socket file is sitting at `path`. Optional, because it only ever sharpens a failure message: a file
   * that is there but refuses connections means JSLab is starting or died badly, which is not "JSLab isn't running".
   */
  socketExists?(path: string): Promise<boolean>;
}

/** Spec §16.3: "polls for the socket for up to 10 s". */
export const LAUNCH_TIMEOUT_MS = 10_000;
export const LAUNCH_POLL_MS = 200;
export const CALL_TIMEOUT_MS = 30_000;

/**
 * Spec §16.3's autolaunch, which a scripted or sandboxed run (the E2E suite included) must be able to turn off so it
 * never launches the user's installed JSLab. Task 6's `main.ts` passes `process.env` straight in.
 */
export function launchAllowed(env: Record<string, string | undefined>): boolean {
  return env.JSLAB_CLI_NO_LAUNCH !== "1";
}

export type ParsedReply = { kind: "ok"; result: Record<string, unknown> } | { kind: "error"; message: string };

/**
 * Turns one reply line into a result or a message. The socket carries untrusted bytes in this direction too, so
 * every shape `handleLine` cannot produce ends as an error rather than as a `JSON.parse` throw inside a socket
 * callback, which would leave the call hanging until its timeout. `handleLine` writes `id` and `ok` last, so the
 * flags here are always the server's own and the result needs no sanitising.
 */
export function parseReply(line: string, method: string): ParsedReply {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return { kind: "error", message: `JSLab's reply to ${method} wasn't JSON` };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { kind: "error", message: `JSLab's reply to ${method} wasn't a JSON object` };
  }
  const reply = raw as Record<string, unknown>;
  if (typeof reply.ok !== "boolean") return { kind: "error", message: `JSLab's reply to ${method} had no ok flag` };
  if (reply.ok) return { kind: "ok", result: reply };
  return { kind: "error", message: typeof reply.error === "string" ? reply.error : `${method} failed` };
}

async function firstConnection(paths: string[], transport: CliTransport): Promise<CliConnection | null> {
  for (const path of paths) {
    const connection = await transport.connect(path);
    if (connection) return connection;
  }
  return null;
}

/** The first candidate whose socket file is present — the difference between "not running" and "not answering". */
async function firstExistingSocket(paths: string[], transport: CliTransport): Promise<string | undefined> {
  const exists = transport.socketExists;
  if (exists === undefined) return undefined;
  for (const path of paths) {
    if (await exists.call(transport, path)) return path;
  }
  return undefined;
}

/**
 * Spec §16.3: try each candidate socket; if none answers and launching is allowed, run `open -b dev.jslab.app` and
 * poll for up to 10 s. Arguments are never passed to the app — the request goes over the socket, which is what
 * avoids Electrobun #540.
 */
export async function connectOrLaunch(
  paths: string[],
  transport: CliTransport,
  allowLaunch: boolean,
): Promise<CliConnection> {
  if (paths.length === 0) {
    throw new Error(
      `No JSLab socket path to try (check JSLAB_SOCKET / JSLAB_USER_DATA; a socket path holds at most ${MAX_SOCKET_PATH_BYTES} bytes)`,
    );
  }
  const live = await firstConnection(paths, transport);
  if (live) return live;

  const [first] = paths as [string, ...string[]];
  const stale = await firstExistingSocket(paths, transport);
  if (!allowLaunch) {
    throw new Error(
      stale === undefined
        ? `JSLab isn't running, and launching is off (no socket at ${first})`
        : `JSLab isn't answering: ${stale} exists but refuses connections — it may be a stale socket file, or JSLab may still be starting — and launching is off`,
    );
  }

  await transport.launch();
  const deadline = transport.now() + LAUNCH_TIMEOUT_MS;
  while (transport.now() < deadline) {
    await transport.sleep(LAUNCH_POLL_MS);
    const connected = await firstConnection(paths, transport);
    if (connected) return connected;
  }
  const seconds = LAUNCH_TIMEOUT_MS / 1000;
  const lingering = await firstExistingSocket(paths, transport);
  throw new Error(
    lingering === undefined
      ? `JSLab didn't answer on ${first} within ${seconds} s`
      : `JSLab didn't answer on ${lingering} within ${seconds} s: the socket file exists but refuses connections, so it is probably stale`,
  );
}

/** The real transport: a Bun unix socket, and `open -b` for the launch. */
export const bunTransport: CliTransport = {
  connect: (path) => bunConnect(path),
  launch: async () => {
    const proc = Bun.spawn(["/usr/bin/open", "-b", APP_BUNDLE_ID], { stdout: "ignore", stderr: "pipe" });
    const code = await proc.exited;
    if (code !== 0) throw new Error(`Couldn't launch JSLab: ${(await new Response(proc.stderr).text()).trim()}`);
  },
  sleep: (ms) => Bun.sleep(ms),
  now: () => Date.now(),
  socketExists: async (path) => existsSync(path),
};

/**
 * One NDJSON connection (`apps/desktop/src/main/cli/ndjson.ts` is the other end). Deliberately minimal: `jslab`
 * makes one call and exits, so there is no reconnect, no queue and no keepalive. The reply is read through the
 * server's own `LineBuffer`, so an endless reply is cut off at the same bound instead of growing without limit.
 */
async function bunConnect(path: string): Promise<CliConnection | null> {
  let onData: (chunk: string) => void = () => {};
  let onClose: () => void = () => {};
  let onDrain: () => void = () => {};
  let socket: Awaited<ReturnType<typeof Bun.connect<undefined>>>;
  const decoder = new TextDecoder();
  try {
    socket = await Bun.connect<undefined>({
      unix: path,
      socket: {
        data: (_socket, data) => onData(decoder.decode(data, { stream: true })),
        drain: () => onDrain(),
        close: () => onClose(),
        error: () => onClose(),
      },
    });
  } catch {
    return null;
  }

  return {
    call(method, params, timeoutMs = CALL_TIMEOUT_MS) {
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        const buffer = new LineBuffer();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const settle = (finish: () => void) => {
          if (timer !== undefined) clearTimeout(timer);
          onData = () => {};
          onClose = () => {};
          onDrain = () => {};
          finish();
        };
        timer = setTimeout(
          () => settle(() => reject(new Error(`JSLab didn't reply to ${method} within ${timeoutMs} ms`))),
          timeoutMs,
        );
        onClose = () => settle(() => reject(new Error("The JSLab socket closed before replying")));
        onData = (chunk) => {
          let lines: string[];
          try {
            lines = buffer.push(chunk);
          } catch {
            settle(() => reject(new Error(`JSLab's reply to ${method} was too long`)));
            return;
          }
          const [line] = lines;
          if (line === undefined) return;
          const parsed = parseReply(line, method);
          settle(() => (parsed.kind === "ok" ? resolve(parsed.result) : reject(new Error(parsed.message))));
        };

        // macOS's unix-socket send buffer is ~8 KB, so a piped script larger than that only arrives in full if the
        // unwritten remainder is resent on `drain` — otherwise the server waits forever for a line it never gets.
        let pending = Buffer.from(`${JSON.stringify({ v: 1, id: "1", method, params })}\n`);
        const pump = () => {
          while (pending.length > 0) {
            const written = socket.write(pending);
            if (written <= 0) return;
            pending = pending.subarray(written);
          }
        };
        onDrain = pump;
        pump();
      });
    },
    close: () => socket.end(),
  };
}
