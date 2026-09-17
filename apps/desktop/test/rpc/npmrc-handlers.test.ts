import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { lstat, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_NPMRC_BYTES } from "@jslab/rpc-schema";
import { DEFAULT_NPMRC } from "@jslab/shared";
import { FileTooLargeError, NotARegularFileError } from "../../src/main/fs/bounded-read";
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

  /**
   * F2. `npmrc.get` shipped the whole file over RPC with no cap: `MAX_NPMRC_CHARS` was enforced on save and never
   * on read, and this is the third-party-writable side (`npm config set`, `npm login`, any postinstall). Refusing
   * is deliberately not the same as returning the default -- the default would be offered to the user as the
   * current contents and then saved straight over their real file.
   */
  test("get refuses an oversized .npmrc, naming the size, instead of returning the default", async () => {
    const path = join(dir, ".npmrc");
    await writeFile(path, "x".repeat(MAX_NPMRC_BYTES + 1));
    const handlers = createNpmrcHandlers({ path, onSaved: () => {}, log: () => {} });

    const error = (await handlers.requests["npmrc.get"]({}).catch((reason: unknown) => reason)) as FileTooLargeError;
    expect(error).toBeInstanceOf(FileTooLargeError);
    expect(error.message).toContain(String(MAX_NPMRC_BYTES + 1));
    expect(error.message).not.toBe(DEFAULT_NPMRC);
  });

  test("get refuses a FIFO .npmrc rather than blocking on it", async () => {
    const path = join(dir, ".npmrc");
    expect(await Bun.spawn(["mkfifo", path]).exited).toBe(0);
    const handlers = createNpmrcHandlers({ path, onSaved: () => {}, log: () => {} });
    // Without O_NONBLOCK this open parks on a threadpool thread until a writer appears and the test times out.
    await expect(handlers.requests["npmrc.get"]({})).rejects.toBeInstanceOf(NotARegularFileError);
  }, 5000);

  test("get still returns the default when there is simply no .npmrc yet", async () => {
    const handlers = createNpmrcHandlers({ path: join(dir, "absent", ".npmrc"), onSaved: () => {}, log: () => {} });
    expect(await handlers.requests["npmrc.get"]({})).toEqual({ content: DEFAULT_NPMRC });
  });

  /**
   * F-NPMRC. `npmrc.get` refuses to hand back the default for a file that is present but unreadable, precisely so
   * the user is never invited to save that default over their real `.npmrc`. `npmrc.reset` then wrote the default
   * unconditionally, which destroyed the same file directly: the Settings Reset button stayed enabled after a
   * failed load, and its two clicks arrived here. The guard belongs on this side as well as in the UI -- a UI-only
   * guard leaves the path open to every other caller of the request.
   */
  test("reset refuses to overwrite an oversized .npmrc, leaving the user's real file untouched", async () => {
    const path = join(dir, ".npmrc");
    const real = "x".repeat(MAX_NPMRC_BYTES + 1);
    await writeFile(path, real);
    const onSaved = mock(() => {});
    const handlers = createNpmrcHandlers({ path, onSaved, log: () => {} });

    await expect(handlers.requests["npmrc.reset"]({})).rejects.toBeInstanceOf(FileTooLargeError);
    expect(await readFile(path, "utf8")).toBe(real);
    expect(onSaved).not.toHaveBeenCalled();
  });

  test("reset refuses a FIFO .npmrc rather than replacing it", async () => {
    const path = join(dir, ".npmrc");
    expect(await Bun.spawn(["mkfifo", path]).exited).toBe(0);
    const handlers = createNpmrcHandlers({ path, onSaved: () => {}, log: () => {} });

    await expect(handlers.requests["npmrc.reset"]({})).rejects.toBeInstanceOf(NotARegularFileError);
    expect((await lstat(path)).isFIFO()).toBe(true);
  }, 5000);

  test("reset still writes the default when there is simply no .npmrc yet", async () => {
    const path = join(dir, ".npmrc");
    const onSaved = mock(() => {});
    const handlers = createNpmrcHandlers({ path, onSaved, log: () => {} });

    expect(await handlers.requests["npmrc.reset"]({})).toEqual({ content: DEFAULT_NPMRC });
    expect(await readFile(path, "utf8")).toBe(DEFAULT_NPMRC);
    expect(onSaved).toHaveBeenCalledTimes(1);
  });
});
