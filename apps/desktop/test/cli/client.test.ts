import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Socket } from "bun";
import {
  bunTransport,
  type CliConnection,
  type CliTransport,
  connectOrLaunch,
  LAUNCH_POLL_MS,
  LAUNCH_TIMEOUT_MS,
  launchAllowed,
  parseReply,
} from "../../src/cli/client";
import { encodeLine, handleLine, type SocketMethod } from "../../src/main/cli/ndjson";
import { type SocketServer, startSocketServer } from "../../src/main/cli/socket-server";

function connection(label: string): CliConnection {
  return { call: async () => ({ label }), close: () => {} };
}

/** A transport whose socket appears after `appearAfterMs` of simulated time. Nothing real is launched. */
function fakeTransport(options: { live?: string; appearAfterMs?: number; existing?: string[] }) {
  let elapsed = 0;
  let launched = 0;
  const transport: CliTransport = {
    connect: mock(async (path: string) => {
      if (options.live === path) return connection(path);
      if (options.appearAfterMs !== undefined && launched > 0 && elapsed >= options.appearAfterMs) {
        return connection(path);
      }
      return null;
    }),
    launch: mock(async () => {
      launched += 1;
    }),
    sleep: async (ms: number) => {
      elapsed += ms;
    },
    now: () => elapsed,
    // Left off entirely unless the case is about a socket file that exists, so the default path stays exercised.
    ...(options.existing === undefined
      ? {}
      : { socketExists: async (path: string) => options.existing?.includes(path) === true }),
  };
  return { transport, launches: () => launched };
}

describe("connectOrLaunch", () => {
  test("uses the first live socket and never launches anything", async () => {
    const { transport, launches } = fakeTransport({ live: "/b/jslab.sock" });
    const connected = await connectOrLaunch(["/a/jslab.sock", "/b/jslab.sock"], transport, true);
    expect(await connected.call("open", {})).toEqual({ label: "/b/jslab.sock" });
    expect(launches()).toBe(0);
  });

  test("launches the app and polls until the socket appears (§16.3)", async () => {
    const { transport, launches } = fakeTransport({ appearAfterMs: 1000 });
    const connected = await connectOrLaunch(["/a/jslab.sock"], transport, true);
    expect(await connected.call("open", {})).toEqual({ label: "/a/jslab.sock" });
    expect(launches()).toBe(1);
  });

  test("gives up after the 10 s the spec allows, naming the socket it waited for", async () => {
    const { transport } = fakeTransport({});
    await expect(connectOrLaunch(["/a/jslab.sock"], transport, true)).rejects.toThrow(
      `JSLab didn't answer on /a/jslab.sock within ${LAUNCH_TIMEOUT_MS / 1000} s`,
    );
  });

  test("pins the 10 s launch wait and 200 ms poll to the numbers the spec names", () => {
    // The test above builds its expected message out of LAUNCH_TIMEOUT_MS, so it cannot notice that constant
    // drifting away from spec §16.3's "up to 10 s". This one can, and it is the only cover LAUNCH_POLL_MS has.
    expect(LAUNCH_TIMEOUT_MS).toBe(10_000);
    expect(LAUNCH_POLL_MS).toBe(200);
  });

  test("with launching off, a missing socket fails immediately and nothing is launched", async () => {
    const { transport, launches } = fakeTransport({});
    await expect(connectOrLaunch(["/a/jslab.sock"], transport, false)).rejects.toThrow("JSLab isn't running");
    expect(launches()).toBe(0);
  });

  test("no candidate path at all is a clear error, not a hang", async () => {
    const { transport } = fakeTransport({});
    await expect(connectOrLaunch([], transport, true)).rejects.toThrow("No JSLab socket path to try");
  });

  test("a socket file that refuses connections is reported as unreachable, not as a missing app", async () => {
    const { transport } = fakeTransport({ existing: ["/b/jslab.sock"] });
    await expect(connectOrLaunch(["/a/jslab.sock", "/b/jslab.sock"], transport, false)).rejects.toThrow(
      "/b/jslab.sock exists but refuses connections",
    );
  });

  test("after a launch times out, an existing socket file says so instead of blaming a missing app", async () => {
    const { transport } = fakeTransport({ existing: ["/a/jslab.sock"] });
    await expect(connectOrLaunch(["/a/jslab.sock"], transport, true)).rejects.toThrow(
      "the socket file exists but refuses connections",
    );
  });
});

describe("launchAllowed", () => {
  test("JSLAB_CLI_NO_LAUNCH=1 is the only value that turns launching off", () => {
    expect(launchAllowed({})).toBe(true);
    expect(launchAllowed({ JSLAB_CLI_NO_LAUNCH: "1" })).toBe(false);
    expect(launchAllowed({ JSLAB_CLI_NO_LAUNCH: "0" })).toBe(true);
    expect(launchAllowed({ JSLAB_CLI_NO_LAUNCH: "" })).toBe(true);
  });
});

describe("parseReply", () => {
  /**
   * The drift guard M4 taught this codebase to write: every reply `handleLine` can produce must classify, and the
   * classification must agree with the server's own `ok`. A third `SocketResponse` arm fails this in one direction;
   * a client that stops recognising the error arm fails it in the other.
   */
  test("classifies every reply handleLine can actually send, in agreement with its ok flag", async () => {
    const methods: Record<string, SocketMethod> = {
      fine: async () => ({ tabIds: ["t1"] }),
      boom: async () => {
        throw new Error("handler exploded");
      },
    };
    const requests = [
      '{"v":1,"id":"1","method":"fine"}', // ok
      '{"v":1,"id":"2","method":"boom"}', // handler threw
      '{"v":1,"id":"3","method":"nope"}', // unknown method
      "not json at all", // invalid JSON
      '{"v":2,"id":"4","method":"fine"}', // invalid request
    ];
    expect(requests).toHaveLength(5);
    for (const request of requests) {
      const response = await handleLine(request, methods);
      const parsed = parseReply(encodeLine(response).trimEnd(), "fine");
      if (response.ok) {
        expect(parsed).toEqual({ kind: "ok", result: response as unknown as Record<string, unknown> });
      } else {
        expect(parsed).toEqual({ kind: "error", message: response.error });
      }
    }
  });

  test("a reply the server could never send fails loudly instead of being trusted", () => {
    expect(parseReply("}{", "open")).toEqual({ kind: "error", message: "JSLab's reply to open wasn't JSON" });
    expect(parseReply("null", "open")).toEqual({
      kind: "error",
      message: "JSLab's reply to open wasn't a JSON object",
    });
    expect(parseReply("[1,2]", "open")).toEqual({
      kind: "error",
      message: "JSLab's reply to open wasn't a JSON object",
    });
    expect(parseReply('{"id":"1"}', "open")).toEqual({
      kind: "error",
      message: "JSLab's reply to open had no ok flag",
    });
    expect(parseReply('{"id":"1","ok":false}', "open")).toEqual({ kind: "error", message: "open failed" });
  });
});

describe("bunTransport", () => {
  let dir = "";
  let server: SocketServer | null = null;
  let listener: ReturnType<typeof Bun.listen<undefined>> | null = null;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.env.JSLAB_E2E_TMPDIR ?? tmpdir(), "jcli-"));
  });
  afterEach(async () => {
    server?.close();
    server = null;
    listener?.stop(true);
    listener = null;
    await rm(dir, { recursive: true, force: true });
  });

  /** A server that answers nothing like JSLab. `reply` runs once the first request line arrives. */
  function rogueServer(path: string, reply: (socket: Socket<undefined>) => void) {
    listener = Bun.listen<undefined>({ unix: path, socket: { data: (socket) => reply(socket) } });
    return path;
  }

  test("connect resolves null when nothing is listening, rather than throwing", async () => {
    expect(await bunTransport.connect(join(dir, "jslab.sock"))).toBeNull();
  });

  test("call sends NDJSON the real server understands and resolves with its result", async () => {
    const path = join(dir, "jslab.sock");
    server = await startSocketServer({
      path,
      log: () => {},
      methods: { open: async () => ({ tabIds: ["tab-1", "tab-2"] }) },
    });
    const connected = await bunTransport.connect(path);
    expect(connected).not.toBeNull();
    const reply = await (connected as CliConnection).call("open", { files: ["/Users/me/a.ts"] }, 2000);
    expect(reply).toEqual({ id: "1", ok: true, tabIds: ["tab-1", "tab-2"] });
    connected?.close();
  });

  test("a request larger than the socket's send buffer is delivered whole, not truncated", async () => {
    const path = join(dir, "jslab.sock");
    server = await startSocketServer({
      path,
      log: () => {},
      methods: { open: async (params) => ({ size: (params as { code: string }).code.length }) },
    });
    const connected = await bunTransport.connect(path);
    const reply = await (connected as CliConnection).call("open", { code: "c".repeat(1_000_000) }, 4000);
    expect(reply).toEqual({ id: "1", ok: true, size: 1_000_000 });
    connected?.close();
  }, 10000);

  test("a server error reply becomes a rejection carrying the server's own message", async () => {
    const path = join(dir, "jslab.sock");
    server = await startSocketServer({ path, log: () => {}, methods: {} });
    const connected = await bunTransport.connect(path);
    await expect((connected as CliConnection).call("open", {}, 2000)).rejects.toThrow("Unknown method: open");
    connected?.close();
  });

  test("a reply that isn't JSON fails loudly instead of hanging until the call times out", async () => {
    const path = rogueServer(join(dir, "jslab.sock"), (socket) => socket.write("definitely not json\n"));
    const connected = await bunTransport.connect(path);
    await expect((connected as CliConnection).call("open", {}, 2000)).rejects.toThrow(
      "JSLab's reply to open wasn't JSON",
    );
    connected?.close();
  });

  test("a socket that closes without replying fails loudly instead of hanging", async () => {
    const path = rogueServer(join(dir, "jslab.sock"), (socket) => socket.end());
    const connected = await bunTransport.connect(path);
    await expect((connected as CliConnection).call("open", {}, 2000)).rejects.toThrow(
      "The JSLab socket closed before replying",
    );
    connected?.close();
  });

  test("a reply with no end in sight is cut off rather than buffered without limit", async () => {
    const chunk = "x".repeat(64 * 1024);
    let sent = 0;
    const flood = (socket: Socket<undefined>) => {
      while (sent < 6_000_000) {
        const written = socket.write(chunk);
        sent += written;
        if (written < chunk.length) return; // Wait for `drain`.
      }
    };
    listener = Bun.listen<undefined>({
      unix: join(dir, "jslab.sock"),
      socket: { data: flood, drain: flood },
    });
    const connected = await bunTransport.connect(join(dir, "jslab.sock"));
    await expect((connected as CliConnection).call("open", {}, 4000)).rejects.toThrow(
      "JSLab's reply to open was too long",
    );
    connected?.close();
  }, 10000);

  test("a stale socket file is reported as unreachable, and nothing is launched to find out", async () => {
    const path = join(dir, "jslab.sock");
    writeFileSync(path, "stale");
    expect(await bunTransport.connect(path)).toBeNull();
    await expect(connectOrLaunch([path], bunTransport, false)).rejects.toThrow("exists but refuses connections");
  });
});
