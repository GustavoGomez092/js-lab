import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JSLabClient, JSLabError } from "../src/client";

let dir = "";
let stop: (() => void) | null = null;

beforeEach(async () => {
  dir = await mkdtemp(join(process.env.JSLAB_E2E_TMPDIR ?? tmpdir(), "jcli-"));
});
afterEach(async () => {
  stop?.();
  stop = null;
  await rm(dir, { recursive: true, force: true });
});

/** A tiny NDJSON server: "ok" echoes params, "fail" errors, "silent" never answers. */
function fakeServer(path: string) {
  const listener = Bun.listen<undefined>({
    unix: path,
    socket: {
      data(socket, data) {
        for (const line of new TextDecoder().decode(data).split("\n").filter(Boolean)) {
          const request = JSON.parse(line) as { id: string; method: string; params: unknown };
          if (request.method === "ok")
            socket.write(`${JSON.stringify({ echo: request.params, id: request.id, ok: true })}\n`);
          if (request.method === "fail")
            socket.write(`${JSON.stringify({ id: request.id, ok: false, error: "nope" })}\n`);
        }
      },
    },
  });
  stop = () => listener.stop(true);
}

describe("JSLabClient", () => {
  test("correlates replies by id", async () => {
    const path = join(dir, "s.sock");
    fakeServer(path);
    const client = await JSLabClient.connect(path);
    const [a, b] = await Promise.all([client.call("ok", { n: 1 }), client.call("ok", { n: 2 })]);
    expect([a.echo, b.echo]).toEqual([{ n: 1 }, { n: 2 }]);
    client.close();
  });

  test("turns ok:false replies into JSLabError", async () => {
    const path = join(dir, "s.sock");
    fakeServer(path);
    const client = await JSLabClient.connect(path);
    const error = await client.call("fail").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JSLabError);
    expect((error as Error).message).toBe("fail: nope");
    client.close();
  });

  test("times out when no reply arrives", async () => {
    const path = join(dir, "s.sock");
    fakeServer(path);
    const client = await JSLabClient.connect(path);
    await expect(client.call("silent", {}, 30)).rejects.toThrow("silent: no reply within 30 ms");
    client.close();
  });
});
