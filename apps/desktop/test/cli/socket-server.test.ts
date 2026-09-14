import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type SocketServer, startSocketServer } from "../../src/main/cli/socket-server";

let dir = "";
let server: SocketServer | null = null;
const log = () => {};

beforeEach(async () => {
  dir = await mkdtemp(join(process.env.JSLAB_E2E_TMPDIR ?? tmpdir(), "jsock-"));
});
afterEach(async () => {
  server?.close();
  server = null;
  await rm(dir, { recursive: true, force: true });
});

/** Sends raw text and resolves with the first `count` reply lines. */
async function exchange(path: string, text: string, count: number): Promise<unknown[]> {
  const replies: unknown[] = [];
  let pending = "";
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out with ${replies.length} replies`)), 2000);
    void Bun.connect({
      unix: path,
      socket: {
        data(socket, data) {
          pending += new TextDecoder().decode(data);
          const lines = pending.split("\n");
          pending = lines.pop() ?? "";
          for (const line of lines) replies.push(JSON.parse(line));
          if (replies.length >= count) {
            clearTimeout(timer);
            socket.end();
            resolve(replies);
          }
        },
        open(socket) {
          socket.write(text);
        },
      },
    });
  });
}

describe("startSocketServer", () => {
  test("serves requests over a 0600 unix socket", async () => {
    const path = join(dir, "jslab.sock");
    server = await startSocketServer({ path, log, methods: { ping: async () => ({ pong: true }) } });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(await exchange(path, '{"v":1,"id":"a","method":"ping"}\n', 1)).toEqual([{ pong: true, id: "a", ok: true }]);
  });

  test("handles several requests in one chunk and requests split across chunks", async () => {
    const path = join(dir, "jslab.sock");
    server = await startSocketServer({ path, log, methods: { ping: async () => ({ pong: true }) } });
    const replies = await exchange(
      path,
      '{"v":1,"id":"1","method":"ping"}\n{"v":1,"id":"2","method":"ping"}\n{"v":1,"id":"3","method":"missing"}\n',
      3,
    );
    expect((replies as { id: string }[]).map((reply) => reply.id).sort()).toEqual(["1", "2", "3"]);
  });

  test("replaces a stale socket file but refuses to steal a live one", async () => {
    const path = join(dir, "jslab.sock");
    writeFileSync(path, "stale");
    server = await startSocketServer({ path, log, methods: {} });
    await expect(startSocketServer({ path, log, methods: {} })).rejects.toThrow(/Another JSLab instance/);
  });

  test("close removes the socket file", async () => {
    const path = join(dir, "jslab.sock");
    const local = await startSocketServer({ path, log, methods: {} });
    local.close();
    expect(existsSync(path)).toBe(false);
  });
});
