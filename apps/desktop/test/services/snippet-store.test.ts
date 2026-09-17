import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_SNIPPETS, SNIPPETS_FORMAT, SNIPPETS_VERSION, type Snippet } from "@jslab/shared";
import { SnippetStore } from "../../src/main/services/snippet-store";

const AT = "2026-09-16T10:00:00.000Z";
const record = (overrides: Partial<Snippet> = {}): Snippet => ({
  id: "s1",
  name: "fetchjson",
  description: "Fetch + parse JSON",
  body: "await fetch($0)",
  language: "typescript",
  createdAt: AT,
  updatedAt: AT,
  ...overrides,
});

const library = (snippets: unknown[], version: number = SNIPPETS_VERSION) =>
  JSON.stringify({ format: SNIPPETS_FORMAT, version, snippets });

let dir = "";
let path = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jl-snippets-"));
  path = join(dir, "snippets.json");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("SnippetStore (spec §4.5, §13.4)", () => {
  test("a missing file starts empty, and save writes the documented format", async () => {
    const store = await SnippetStore.open(path);
    expect([store.snippets, store.recovered]).toEqual([[], "none"]);

    await store.save([record()]);
    expect(store.snippets).toEqual([record()]);
    const written = JSON.parse(await readFile(path, "utf8"));
    expect(written).toEqual({ format: SNIPPETS_FORMAT, version: SNIPPETS_VERSION, snippets: [record()] });

    const reopened = await SnippetStore.open(path);
    expect(reopened.snippets).toEqual([record()]);
  });

  test("a corrupt file is kept aside and the store starts empty rather than refusing to open", async () => {
    await writeFile(path, "{ not json at all");
    const store = await SnippetStore.open(path, { now: () => 1234 });
    expect([store.snippets, store.recovered]).toEqual([[], "defaults"]);
    expect(await readdir(dir)).toContain("snippets.corrupt-1234.json");
  });

  test("a file that parses but isn't a snippet library is treated the same way", async () => {
    await writeFile(path, JSON.stringify({ format: "vscode-snippets", version: 1, snippets: [] }));
    const store = await SnippetStore.open(path, { now: () => 99 });
    expect(store.recovered).toBe("defaults");
    expect(await readdir(dir)).toContain("snippets.corrupt-99.json");
  });

  test("a read failure that isn't ENOENT throws instead of silently emptying the library (EnvStore's FR-2)", async () => {
    // A directory in place of the file: readFile fails with EISDIR, not ENOENT.
    const asDirectory = join(dir, "as-a-directory");
    await mkdir(asDirectory, { recursive: true });
    await expect(SnippetStore.open(asDirectory)).rejects.toThrow();
  });

  test("save validates before writing, and a rejected save leaves the file untouched", async () => {
    const store = await SnippetStore.open(path);
    await store.save([record()]);
    const before = await readFile(path, "utf8");
    await expect(store.save([record({ name: "not a valid name" })])).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe(before);
    expect(store.snippets).toEqual([record()]);
  });

  test("writes go through writeFileAtomic with a backup", async () => {
    const calls: { path: string; backup: boolean | undefined }[] = [];
    const store = await SnippetStore.open(path, {
      write: async (target, _data, options) => void calls.push({ path: target, backup: options.backup }),
    });
    await store.save([record()]);
    expect(calls).toEqual([{ path, backup: true }]);
  });

  test("two snippets sharing an id are kept aside rather than loaded (the reader is the authority)", async () => {
    await writeFile(path, library([record(), record({ name: "other" })]));
    const store = await SnippetStore.open(path, { now: () => 7 });
    expect([store.snippets, store.recovered]).toEqual([[], "defaults"]);
    expect(await readdir(dir)).toContain("snippets.corrupt-7.json");
  });

  test("a wrong-typed field in one snippet is kept aside rather than loaded", async () => {
    await writeFile(path, library([{ ...record(), body: 42 }]));
    const store = await SnippetStore.open(path, { now: () => 8 });
    expect([store.snippets, store.recovered]).toEqual([[], "defaults"]);
    expect(await readdir(dir)).toContain("snippets.corrupt-8.json");
  });

  test("a library written by a newer JSLab is kept aside rather than half-parsed", async () => {
    await writeFile(path, library([record()], SNIPPETS_VERSION + 1));
    const store = await SnippetStore.open(path, { now: () => 9 });
    expect([store.snippets, store.recovered]).toEqual([[], "defaults"]);
    expect(await readdir(dir)).toContain("snippets.corrupt-9.json");
  });

  test("unknown keys in a stored snippet are dropped, not rejected", async () => {
    await writeFile(path, library([{ ...record(), shortcut: "cmd+k" }]));
    const store = await SnippetStore.open(path);
    expect([store.snippets, store.recovered]).toEqual([[record()], "none"]);
  });

  test("a corrupt file with a good backup recovers the library instead of starting empty", async () => {
    await writeFile(path, "{ not json at all");
    await writeFile(`${path}.bak`, library([record()]));
    const store = await SnippetStore.open(path, { now: () => 11 });
    expect([store.snippets, store.recovered]).toEqual([[record()], "backup"]);
    expect(await readdir(dir)).toContain("snippets.corrupt-11.json");
  });

  test("a missing file with a good backup recovers the library too", async () => {
    await writeFile(`${path}.bak`, library([record()]));
    const store = await SnippetStore.open(path);
    expect([store.snippets, store.recovered]).toEqual([[record()], "backup"]);
  });

  test("a corrupt file with a corrupt backup still opens, empty", async () => {
    await writeFile(path, "{ not json at all");
    await writeFile(`${path}.bak`, "{ nor is this");
    const store = await SnippetStore.open(path, { now: () => 12 });
    expect([store.snippets, store.recovered]).toEqual([[], "defaults"]);
  });

  test("save refuses more than MAX_SNIPPETS and leaves the file untouched", async () => {
    const store = await SnippetStore.open(path);
    await store.save([record()]);
    const before = await readFile(path, "utf8");
    const tooMany = Array.from({ length: MAX_SNIPPETS + 1 }, (_, index) =>
      record({ id: `s${index}`, name: `n${index}` }),
    );
    await expect(store.save(tooMany)).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe(before);
    expect(store.snippets).toEqual([record()]);
  });

  test("save refuses a library its own reader would reject, so JSLab can never corrupt snippets.json", async () => {
    const store = await SnippetStore.open(path);
    // Per-record validation cannot see this: two distinct, individually valid records with the same name.
    await expect(store.save([record(), record({ id: "s2" })])).rejects.toThrow();
    await expect(store.save([record(), record({ name: "other" })])).rejects.toThrow();
    expect(store.snippets).toEqual([]);
  });
});
