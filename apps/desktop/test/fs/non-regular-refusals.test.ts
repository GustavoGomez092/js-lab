import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultSettings } from "@jslab/shared";
import { VendorCache } from "../../src/main/bundling/vendor-cache";
import { RotatingLog } from "../../src/main/logging/rotating-log";
import { loadJson } from "../../src/main/persistence/json-store";
import { SystemFontsService } from "../../src/main/platform/system-fonts";
import { EnvStore } from "../../src/main/services/env-store";
import { KeybindingsStore } from "../../src/main/services/keybindings-store";
import { SessionStore } from "../../src/main/services/session-store";
import { SettingsStore } from "../../src/main/services/settings-store";

/**
 * Every store that reads one of JSLab's own files out of its own data dir, driven with a NON-REGULAR file at the
 * path it reads.
 *
 * These reads were all excused, for a long time, as "JSLab's own file in its own data dir". That answers how large
 * the file can be, and says nothing about what kind of file is at the path when it is finally read -- and every one
 * of these paths is user-writable, so the two are unrelated. A FIFO at settings.json or main.log blocks Main
 * forever on a `read(2)` that never returns, which no `try`/`catch` around the call can rescue.
 *
 * FIFOs are used for the asynchronous sites, where a blocked read parks a threadpool thread rather than the event
 * loop, so `within` can still fail the test as a hang instead of wedging the runner. The one synchronous site
 * (`RotatingLog.tail`) is driven with a directory instead: it is non-regular in exactly the way the reader checks,
 * and unlike a FIFO it cannot block -- which matters, because nothing inside this process could reclaim the runner
 * if it did. That the FIFO case specifically blocks, and no longer does, is proven outside `bun test` by a hard
 * alarm on a spawned pid (see this branch's report), and by `bounded-read.test.ts` for the reader itself.
 */

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jslab-nonregular-"));
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

async function fifoAt(path: string): Promise<string> {
  expect(await Bun.spawn(["mkfifo", path]).exited).toBe(0);
  return path;
}

const isRegular = async (path: string) => (await stat(path)).isFile();

describe("a non-regular file at a data-dir path is refused, not blocked on", () => {
  test("loadJson reports a FIFO as corrupt and recovers, instead of parking on it", async () => {
    const path = await fifoAt(join(dir, "s.json"));
    const parser = { parse: (input: unknown) => input as { n: number } };

    const result = await within(
      2000,
      "loadJson on a FIFO",
      loadJson(path, parser, () => ({ n: 7 }), 1024),
    );

    // "corrupt", not "missing": the file is present and unusable, which is the half of the distinction that is
    // true of a FIFO. That routes it into the existing recovery rather than inventing a new failure mode.
    expect({ value: result.value, primary: result.primary }).toEqual({ value: { n: 7 }, primary: "corrupt" });
  }, 5000);

  test("SettingsStore falls back to defaults on a FIFO settings.json and heals the file", async () => {
    await fifoAt(join(dir, "settings.json"));

    const store = await within(2000, "SettingsStore.open on a FIFO", SettingsStore.open(dir));

    expect(store.current.appearance.theme).toBe(defaultSettings().appearance.theme);
    // The recovery rewrite renames a regular file over the FIFO, so the next launch is an ordinary one.
    expect(await isRegular(join(dir, "settings.json"))).toBe(true);
  }, 5000);

  test("SessionStore falls back to defaults on a FIFO session.json", async () => {
    await fifoAt(join(dir, "session.json"));

    const store = await within(2000, "SessionStore.open on a FIFO", SessionStore.open(dir, { delayMs: 10 }));
    await store.flush();

    expect(Object.keys(store.session.tabs).length).toBeGreaterThan(0);
    expect(await isRegular(join(dir, "session.json"))).toBe(true);
  }, 5000);

  test("SessionStore marks a tab unreadable when its buffer is a FIFO, so an edit cannot overwrite it", async () => {
    const store = await SessionStore.open(dir, { delayMs: 10 });
    const tab = await store.createTab({ content: "real code" });
    const bufferPath = join(dir, "buffers", `${tab.id}.ts`);
    await rm(bufferPath, { force: true });
    await fifoAt(bufferPath);

    // Only a MISSING buffer is an empty one; a present-but-unreadable buffer must surface, never read as "".
    await expect(within(2000, "readBuffer on a FIFO", store.readBuffer(tab.id))).rejects.toThrow(
      `Couldn't read the buffer for tab ${tab.id}`,
    );

    // And the tab is now latched unreadable, so a later edit never replaces the user's real content.
    store.setBuffer(tab.id, "clobber");
    await store.flush();
    expect(await stat(bufferPath).then((info) => info.isFIFO())).toBe(true);
  }, 5000);

  test("EnvStore fails the caller on a FIFO env.json rather than silently starting empty", async () => {
    const path = await fifoAt(join(dir, "env.json"));

    // FR-2: an empty store here would be written back over the user's real env.json by the next save().
    await expect(within(2000, "EnvStore.open on a FIFO", EnvStore.open(path))).rejects.toThrow(/ENOTREGULAR/);
  }, 5000);

  test("KeybindingsStore flags a FIFO as invalid, while a missing file still means no overrides", async () => {
    const missing = await KeybindingsStore.open(dir);
    expect([missing.rules, missing.invalid]).toEqual([[], false]);

    await fifoAt(join(dir, "keybindings.json"));
    const store = await within(2000, "KeybindingsStore.open on a FIFO", KeybindingsStore.open(dir));

    // Present but unreadable is reported, not quietly rendered as "you have no overrides".
    expect([store.rules, store.invalid]).toEqual([[], true]);
  }, 5000);

  test("SystemFontsService treats a FIFO cache as stale instead of blocking the font list", async () => {
    const cacheFile = await fifoAt(join(dir, "system-fonts.json"));
    const run = async () => JSON.stringify({ SPFontsDataType: [{ _name: "Menlo.ttf" }] });
    const service = new SystemFontsService({ cacheFile, run, now: () => 1000, log: () => {} });

    const listed = await within(2000, "SystemFontsService.list on a FIFO", service.list());
    expect(listed).toEqual({ fonts: null, refreshing: true });
    await within(2000, "the refresh it started", service.refresh());
  }, 5000);

  test("VendorCache treats a FIFO chunk as a miss and repairs the index", async () => {
    const cacheDir = join(dir, "vendor");
    const cache = new VendorCache({ cacheDir });
    await cache.set("k1", { code: "export const a = 1;", map: "{}" });

    const codePath = join(cacheDir, "k1.js");
    await rm(codePath, { force: true });
    await fifoAt(codePath);

    expect(await within(2000, "VendorCache.get on a FIFO chunk", cache.get("k1"))).toBeNull();
    await cache.waitIdle();
    // The repair removed the index entry and both files, so nothing is left orphaned behind the miss.
    expect(await cache.get("k1")).toBeNull();
  }, 5000);

  test("RotatingLog.tail skips a non-regular live log and still returns the rotated lines behind it", async () => {
    const logsDir = join(dir, "logs");
    await mkdir(logsDir, { recursive: true });
    await writeFile(join(logsDir, "main.log.1"), "older one\nolder two\n");
    // A directory is non-regular in exactly the way the reader checks, and cannot block a synchronous read.
    await mkdir(join(logsDir, "main.log"));

    const log = new RotatingLog({ dir: logsDir, echo: () => {} });

    // Losing one file's lines is acceptable; losing the whole tail, or hanging Main, is not.
    expect(log.tail(5)).toEqual(["older one", "older two"]);
  });
});
