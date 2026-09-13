import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "../../src/main/persistence/atomic-write";
import { createDebouncedWriter, loadJson } from "../../src/main/persistence/json-store";
import { RunLock } from "../../src/main/persistence/run-lock";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jslab-persist-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const numberDoc = {
  parse(input: unknown) {
    if (typeof (input as { n?: unknown })?.n !== "number") throw new Error("invalid");
    return input as { n: number };
  },
};

describe("writeFileAtomic", () => {
  test("creates parent folders, writes content and leaves no temp files", async () => {
    const path = join(dir, "nested", "a.json");
    await writeFileAtomic(path, '{"n":1}');
    expect(await readFile(path, "utf8")).toBe('{"n":1}');
    expect(await readdir(join(dir, "nested"))).toEqual(["a.json"]);
  });

  test("keeps the previous version as .bak when asked", async () => {
    const path = join(dir, "a.json");
    await writeFileAtomic(path, "one");
    await writeFileAtomic(path, "two", { backup: true });
    expect(await readFile(`${path}.bak`, "utf8")).toBe("one");
    expect(await readFile(path, "utf8")).toBe("two");
  });

  test("applies the requested file mode", async () => {
    const path = join(dir, "env.json");
    await writeFileAtomic(path, "{}", { mode: 0o600 });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test("removes its temp file when the write fails", async () => {
    const path = join(dir, "x.json");
    const badData = Symbol("bad") as unknown as string;
    try {
      await writeFileAtomic(path, badData);
    } catch {
      // Expected to throw
    }
    const files = readdirSync(dir);
    expect(files.some((f) => f.includes(".tmp-"))).toBe(false);
  });

  test("keeps an existing file's permissions when mode is omitted", async () => {
    const path = join(dir, "env.json");
    await writeFileAtomic(path, "initial", { mode: 0o600 });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await writeFileAtomic(path, "updated");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});

describe("loadJson", () => {
  test("returns defaults without recovery when nothing exists yet", async () => {
    expect(await loadJson(join(dir, "s.json"), numberDoc, () => ({ n: 0 }))).toEqual({
      value: { n: 0 },
      recovered: "none",
    });
  });

  test("loads a valid file", async () => {
    await writeFile(join(dir, "s.json"), '{"n":5}');
    expect(await loadJson(join(dir, "s.json"), numberDoc, () => ({ n: 0 }))).toEqual({
      value: { n: 5 },
      recovered: "none",
    });
  });

  test("falls back to the backup and preserves the corrupt file", async () => {
    await writeFile(join(dir, "s.json"), "{not json");
    await writeFile(join(dir, "s.json.bak"), '{"n":3}');
    expect(await loadJson(join(dir, "s.json"), numberDoc, () => ({ n: 0 }))).toEqual({
      value: { n: 3 },
      recovered: "backup",
    });
    expect((await readdir(dir)).some((name) => name.startsWith("s.corrupt-"))).toBe(true);
  });

  test("uses defaults when both files are invalid", async () => {
    await writeFile(join(dir, "s.json"), '{"n":"x"}');
    expect(await loadJson(join(dir, "s.json"), numberDoc, () => ({ n: 0 }))).toEqual({
      value: { n: 0 },
      recovered: "defaults",
    });
  });
});

describe("createDebouncedWriter", () => {
  test("coalesces scheduled writes into the last value", async () => {
    const writes: string[] = [];
    const writer = createDebouncedWriter(async (data) => void writes.push(data), 20);
    writer.schedule("a");
    writer.schedule("b");
    await Bun.sleep(50);
    expect(writes).toEqual(["b"]);
  });

  test("flush writes immediately and is safe with nothing pending", async () => {
    const writes: string[] = [];
    const writer = createDebouncedWriter(async (data) => void writes.push(data), 10_000);
    writer.schedule("a");
    await writer.flush();
    await writer.flush();
    expect(writes).toEqual(["a"]);
  });

  test("a failed write does not stop later writes", async () => {
    const writes: string[] = [];
    let callCount = 0;
    const errors: unknown[] = [];
    const onError = (error: unknown) => errors.push(error);

    const writer = createDebouncedWriter(
      async (data) => {
        callCount++;
        if (callCount === 1) {
          throw new Error("first write failed");
        }
        writes.push(data);
      },
      10,
      onError,
    );

    writer.schedule("a");
    await Bun.sleep(40);
    expect(errors.length).toBe(1);
    expect(writes).toEqual([]);

    writer.schedule("b");
    await writer.flush();
    expect(writes).toEqual(["b"]);
    expect(errors.length).toBe(1);
  });
});

describe("RunLock", () => {
  test("creates the lock for the first run and removes it after the last", () => {
    const path = join(dir, "run.lock");
    const lock = new RunLock(path);
    expect(lock.uncleanPreviousExit).toBe(false);
    lock.add("r1");
    lock.add("r2");
    expect(existsSync(path)).toBe(true);
    lock.remove("r1");
    expect(existsSync(path)).toBe(true);
    lock.remove("r2");
    expect(existsSync(path)).toBe(false);
  });

  test("detects and clears a lock left by a previous session", async () => {
    const path = join(dir, "run.lock");
    await writeFile(path, "123");
    const lock = new RunLock(path);
    expect(lock.uncleanPreviousExit).toBe(true);
    expect(existsSync(path)).toBe(false);
  });
});
