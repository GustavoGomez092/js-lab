import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENV_FILE_MODE, EnvStore } from "../../src/main/services/env-store";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jslab-env-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const modeOf = async (path: string) => (await stat(path)).mode & 0o777;

describe("EnvStore (spec §12.1)", () => {
  test("starts empty, saves with mode 0600, notifies, reloads and lists secrets", async () => {
    const path = join(dir, "env.json");
    const store = await EnvStore.open(path);
    expect(store.variables).toEqual({});
    const seen: string[][] = [];
    store.onChange((variables) => seen.push(Object.keys(variables)));
    await store.save({ API_URL: "https://x", TOKEN: "s3cr3t-value", N: "1" });
    expect(await modeOf(path)).toBe(ENV_FILE_MODE);
    expect(seen).toEqual([["API_URL", "TOKEN", "N"]]);
    expect(existsSync(`${path}.bak`)).toBe(false);
    const again = await EnvStore.open(path);
    expect(again.variables).toEqual({ API_URL: "https://x", TOKEN: "s3cr3t-value", N: "1" });
    expect(again.secrets()).toEqual(["https://x", "s3cr3t-value"]);
  });

  test("rejects invalid keys without writing", async () => {
    const path = join(dir, "env.json");
    const store = await EnvStore.open(path);
    await expect(store.save({ "1BAD": "x" })).rejects.toThrow();
    expect(existsSync(path)).toBe(false);
    expect(store.variables).toEqual({});
  });

  test("a corrupt file starts empty with a 0600 copy, and a loose mode is tightened", async () => {
    const path = join(dir, "env.json");
    await writeFile(path, "{bad");
    const store = await EnvStore.open(path, { now: () => 42 });
    expect([store.variables, store.recovered]).toEqual([{}, "defaults"]);
    expect(await readdir(dir)).toEqual(["env.corrupt-42.json"]);
    expect(await modeOf(join(dir, "env.corrupt-42.json"))).toBe(ENV_FILE_MODE);

    await writeFile(path, JSON.stringify({ version: 1, variables: { A: "1" } }));
    await chmod(path, 0o644);
    expect((await EnvStore.open(path)).variables).toEqual({ A: "1" });
    expect(await modeOf(path)).toBe(ENV_FILE_MODE);
  });

  test("a non-ENOENT read failure rejects; ENOENT still returns an empty store with recovered: none (FR-2)", async () => {
    // A directory where a file is expected: readFile fails with EISDIR, never ENOENT. Never chmod under the
    // user's home; a directory-shaped path is enough to force a non-ENOENT failure in a temp dir.
    const dirAsFile = join(dir, "env-is-a-dir");
    await mkdir(dirAsFile);
    await expect(EnvStore.open(dirAsFile)).rejects.toThrow();

    const missing = join(dir, "does-not-exist.json");
    const store = await EnvStore.open(missing);
    expect([store.variables, store.recovered]).toEqual([{}, "none"]);
  });
});
