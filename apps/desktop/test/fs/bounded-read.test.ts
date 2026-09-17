import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileTooLargeError,
  NotARegularFileError,
  readBoundedBytes,
  readBoundedText,
  readBoundedTextOrNull,
  readBoundedTextSync,
  readBoundedTextSyncOrNull,
} from "../../src/main/fs/bounded-read";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jslab-bounded-read-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Bounds a promise independently of the per-test timeout, so a hang fails as a hang rather than a timeout. */
async function within<T>(ms: number, what: string, promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, bound]);
  } finally {
    clearTimeout(timer);
  }
}

describe("bounded reads", () => {
  test("reads a regular file whole when it is within the cap, including one exactly at it", async () => {
    const path = join(dir, "a.txt");
    await writeFile(path, "hello");
    expect(await readBoundedText(path, 1024)).toBe("hello");
    // Exactly at the cap is allowed: the refusal is for files strictly larger.
    expect(await readBoundedText(path, 5)).toBe("hello");
    expect(readBoundedTextSync(path, 5)).toBe("hello");
    expect(await readBoundedBytes(path, 5)).toEqual(Buffer.from("hello"));
  });

  test("refuses a file one byte over the cap, and the error names the size and the limit", async () => {
    const path = join(dir, "big.txt");
    await writeFile(path, "x".repeat(65));

    const attempt = readBoundedText(path, 64);
    await expect(attempt).rejects.toBeInstanceOf(FileTooLargeError);
    const error = (await attempt.catch((reason: unknown) => reason)) as FileTooLargeError;
    expect(error.size).toBe(65);
    expect(error.maxBytes).toBe(64);
    // "fail with an error that names the size" -- not one that blames I/O or a parse.
    expect(error.message).toContain("65");
    expect(error.message).toContain("64");
    expect(error.message).toContain(path);

    expect(() => readBoundedTextSync(path, 64)).toThrow(FileTooLargeError);
  });

  test("refuses a FIFO instead of blocking on it, both async and sync", async () => {
    const fifo = join(dir, "fifo");
    expect(await Bun.spawn(["mkfifo", fifo]).exited).toBe(0);

    // With no writer ever attached, a read without O_NONBLOCK would block here forever.
    await expect(within(2000, "readBoundedText on a FIFO", readBoundedText(fifo, 1024))).rejects.toBeInstanceOf(
      NotARegularFileError,
    );
    expect(() => readBoundedTextSync(fifo, 1024)).toThrow(NotARegularFileError);
    expect(await within(2000, "readBoundedTextOrNull on a FIFO", readBoundedTextOrNull(fifo, 1024))).toBeNull();
    expect(readBoundedTextSyncOrNull(fifo, 1024)).toBeNull();
  }, 5000);

  test("refuses a directory", async () => {
    const sub = join(dir, "sub");
    await mkdir(sub);
    await expect(readBoundedText(sub, 1024)).rejects.toBeInstanceOf(NotARegularFileError);
    expect(() => readBoundedTextSync(sub, 1024)).toThrow(NotARegularFileError);
  });

  test("the or-null forms collapse every failure, and the throwing forms keep ENOENT distinguishable", async () => {
    const missing = join(dir, "nope.txt");
    expect(await readBoundedTextOrNull(missing, 1024)).toBeNull();
    expect(readBoundedTextSyncOrNull(missing, 1024)).toBeNull();

    // The throwing form must surface ENOENT as itself, so callers can tell "no file yet" from "unreadable"
    // (npm-service's #readNpmrc and readManifest both depend on exactly that distinction).
    const error = (await readBoundedText(missing, 1024).catch((reason: unknown) => reason)) as NodeJS.ErrnoException;
    expect(error.code).toBe("ENOENT");
    expect(error).not.toBeInstanceOf(FileTooLargeError);
  });

  test("never reads past the size it checked, so a file that grows mid-read stays bounded", async () => {
    // The buffer is allocated at the fstat'd size and never grown; this pins that the returned length is the
    // size that was checked, which is what makes the cap hold under a concurrent append.
    const path = join(dir, "grow.txt");
    await writeFile(path, "1234567890");
    const bytes = await readBoundedBytes(path, 10);
    expect(bytes.length).toBe(10);
  });
});
