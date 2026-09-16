import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_NPMRC } from "@jslab/shared";
import { createNpmrcHandlers } from "../../src/main/rpc/npmrc-handlers";
import { InvalidPayloadError } from "../../src/main/rpc/validate";

// R-M3-T18-ESC-1: the newline is built, never typed as an escape.
const NL = String.fromCharCode(10);

let dir = "";
beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "jslab-npmrc-")));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe(".npmrc handlers (spec §11.5)", () => {
  test("get reads the file or the default, save writes 0600 with a trailing newline, reset restores the default", async () => {
    const path = join(dir, ".npmrc");
    const onSaved = mock(() => {});
    const handlers = createNpmrcHandlers({ path, onSaved, log: () => {} });
    expect(await handlers.requests["npmrc.get"]({})).toEqual({ content: DEFAULT_NPMRC });
    expect(await handlers.requests["npmrc.save"]({ content: "registry=http://127.0.0.1:4873/" })).toEqual({ ok: true });
    expect(await readFile(path, "utf8")).toBe(`registry=http://127.0.0.1:4873/${NL}`);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await handlers.requests["npmrc.get"]({})).toEqual({ content: `registry=http://127.0.0.1:4873/${NL}` });
    expect(await handlers.requests["npmrc.reset"]({})).toEqual({ content: DEFAULT_NPMRC });
    expect(await readFile(path, "utf8")).toBe(DEFAULT_NPMRC);
    expect(onSaved).toHaveBeenCalledTimes(2);
  });

  test("oversized content is rejected, and a failed write is reported without the content", async () => {
    const logged: string[] = [];
    const handlers = createNpmrcHandlers({
      path: join(dir, ".npmrc"),
      write: async () => {
        throw new Error("EROFS: read-only file system");
      },
      onSaved: () => {},
      log: (message, detail) => void logged.push(`${message} ${String(detail)}`),
    });
    expect(() => handlers.requests["npmrc.save"]({ content: "x".repeat(70_000) })).toThrow(InvalidPayloadError);
    expect(await handlers.requests["npmrc.save"]({ content: "//r/:_authToken=npm_secret_token" })).toEqual({
      ok: false,
      error: "EROFS: read-only file system",
    });
    expect(logged.join(NL)).not.toContain("npm_secret_token");
  });
});
