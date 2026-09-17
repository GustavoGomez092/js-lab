import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileTooLargeError, NotARegularFileError, readBoundedText } from "../../src/main/files/bounded-read";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jslab-bounded-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * A sparse file: `size` bytes to every `stat`, zero bytes on disk (verified: `st_blocks` is 0 on APFS). The
 * fixture therefore costs nothing to create and nothing to store -- it only costs memory if something actually
 * reads it, which is exactly the property the first test measures.
 */
async function sparseFile(path: string, size: number): Promise<void> {
  const handle = await open(path, "w");
  try {
    await handle.truncate(size);
  } finally {
    await handle.close();
  }
}

const CAP = 5 * 1024 * 1024;
const OVER_CAP = 512 * 1024 * 1024;
const MB = 1024 * 1024;

describe("readBoundedText (R-M5b-S2)", () => {
  test("a file over the cap is refused WITHOUT its bytes being read into memory", async () => {
    const path = join(dir, "huge.json");
    await sparseFile(path, OVER_CAP);

    const before = process.memoryUsage().rss;
    let text: string | undefined;
    let error: unknown;
    try {
      text = await readBoundedText(path, CAP);
    } catch (caught) {
      error = caught;
    }
    const after = process.memoryUsage().rss;

    expect(error).toBeInstanceOf(FileTooLargeError);
    expect(text).toBeUndefined();
    // The size is known from `fstat`, so the refusal can name it without having read a byte of it.
    expect((error as FileTooLargeError).size).toBe(OVER_CAP);

    // The load-bearing assertion, and the only one that can tell this reader from the shape it replaced. Reading
    // the whole file and *then* measuring it refuses the same file with the same FileTooLargeError -- the two
    // differ only in what the refusal cost: measured here, refusing from the fstat costs ~1.5 MB, and reading
    // 512 MB first costs ~512 MB. 64 MB is 8x clear of both, so this neither flakes nor tolerates the read.
    expect((after - before) / MB).toBeLessThan(64);
  });

  test("a file under the cap is returned in full", async () => {
    const path = join(dir, "library.json");
    const content = `{"format":"jslab-snippets","version":1,"snippets":[]}\n${"x".repeat(4096)}`;
    await writeFile(path, content);
    expect(await readBoundedText(path, CAP)).toBe(content);
  });

  test("the cap is inclusive: exactly maxBytes is read, one byte more is refused", async () => {
    const path = join(dir, "exact.json");
    await writeFile(path, "0123456789");
    expect(await readBoundedText(path, 10)).toBe("0123456789");
    await expect(readBoundedText(path, 9)).rejects.toBeInstanceOf(FileTooLargeError);
  });

  test("an empty file is not mistaken for a refusal", async () => {
    const path = join(dir, "empty.json");
    await writeFile(path, "");
    expect(await readBoundedText(path, CAP)).toBe("");
  });

  test("a path that is not a regular file is refused rather than read", async () => {
    const path = join(dir, "a-directory");
    await mkdir(path);
    await expect(readBoundedText(path, CAP)).rejects.toBeInstanceOf(NotARegularFileError);
  });

  test("a FIFO is refused rather than parking the reader forever", async () => {
    const fifo = join(dir, "pipe.json");
    expect(await Bun.spawn(["mkfifo", fifo]).exited).toBe(0);
    // Deliberately in a child with a hard kill, never in-process: a reader that lost `O_NONBLOCK` blocks inside
    // `open` on a FIFO that has no writer, and no in-process timeout can reclaim a blocked thread -- the whole
    // gate would hang instead of failing. Here, blocking is a killed child and a failed assertion.
    const reader = join(import.meta.dir, "..", "..", "src", "main", "files", "bounded-read.ts");
    const script = [
      `const { readBoundedText } = await import(${JSON.stringify(reader)});`,
      `try { await readBoundedText(${JSON.stringify(fifo)}, 1024); console.log("READ"); }`,
      `catch (error) { console.log(error.name); }`,
    ].join("\n");
    const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "ignore" });
    // 3 s, deliberately below bun's 5 s per-test timeout. If the timeout won the race instead, this test would
    // still fail -- but the kill below would never run, and every run against a blocking reader would leak a bun
    // process parked on the FIFO forever. Measured: the timeout fires at 5001 ms, so 3 s is the safe side.
    const outcome = await Promise.race([child.exited.then(() => "exited"), Bun.sleep(3_000).then(() => "blocked")]);
    if (outcome === "blocked") {
      child.kill("SIGKILL");
      await child.exited;
    }
    expect(outcome).toBe("exited");
    expect((await new Response(child.stdout).text()).trim()).toBe("NotARegularFileError");
  });

  test("a missing file still fails as an ordinary fs error, not as a refusal", async () => {
    const error = await readBoundedText(join(dir, "nope.json"), CAP).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).not.toBeInstanceOf(FileTooLargeError);
    expect(error).not.toBeInstanceOf(NotARegularFileError);
    expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
  });
});
