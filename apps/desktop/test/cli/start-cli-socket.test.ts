import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SocketServer } from "../../src/main/cli/socket-server";
import { startCliSocket } from "../../src/main/cli/start-cli-socket";
import { strings } from "../../src/main/strings";

let dir = "";
const started: (SocketServer | null)[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(process.env.JSLAB_E2E_TMPDIR ?? tmpdir(), "jstart-"));
});
afterEach(async () => {
  for (const server of started.splice(0)) server?.close();
  await rm(dir, { recursive: true, force: true });
});

/** Sends one request line and resolves with the first reply. */
async function ask(path: string, text: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out")), 2000);
    void Bun.connect({
      unix: path,
      socket: {
        data(socket, data) {
          clearTimeout(timer);
          socket.end();
          resolve(JSON.parse(new TextDecoder().decode(data).trim()));
        },
        open(socket) {
          socket.write(text);
        },
      },
    });
  });
}

describe("startCliSocket", () => {
  test("serves the CLI's methods in a normal launch", async () => {
    const path = join(dir, "jslab.sock");
    const log = mock((_message: string, _detail?: unknown) => {});
    const server = await startCliSocket({ path, log, methods: { ping: async () => ({ pong: true }) } });
    started.push(server);
    expect(server?.path).toBe(path);
    expect(await ask(path, '{"v":1,"id":"a","method":"ping"}\n')).toEqual({ pong: true, id: "a", ok: true });
    expect(log).not.toHaveBeenCalled();
  });

  test("a second instance loses the CLI socket rather than failing to start", async () => {
    const path = join(dir, "jslab.sock");
    const log = mock((_message: string, _detail?: unknown) => {});
    const first = await startCliSocket({ path, log, methods: { ping: async () => ({ pong: "first" }) } });
    started.push(first);
    expect(first).not.toBeNull();

    // The whole point of this test: `startSocketServer` throws when another instance already owns the path, and
    // that throw used to be unreachable only because no socket started in a normal launch. It must never reach
    // `errorPolicy.fail`, which would exit 1 the first time a real user opens JSLab twice against a shared appdata.
    const second = await startCliSocket({ path, log, methods: { ping: async () => ({ pong: "second" }) } });
    started.push(second);
    expect(second).toBeNull();
    expect(log.mock.calls[0]?.[0]).toBe(strings.log.cliSocketFailed);
    expect(String(log.mock.calls[0]?.[1])).toMatch(/Another JSLab instance/);

    // The incumbent is untouched: the loser never unlinks or steals the live socket.
    expect(existsSync(path)).toBe(true);
    expect(await ask(path, '{"v":1,"id":"b","method":"ping"}\n')).toEqual({ pong: "first", id: "b", ok: true });
  });
});
