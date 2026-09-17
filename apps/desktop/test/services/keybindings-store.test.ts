import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeybindingsStore } from "../../src/main/services/keybindings-store";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jslab-keys-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("KeybindingsStore", () => {
  test("a missing file means no overrides", async () => {
    const store = await KeybindingsStore.open(dir);
    expect([store.rules, store.invalid, store.path]).toEqual([[], false, join(dir, "keybindings.json")]);
  });

  test("loads valid rules, drops invalid ones and flags unreadable JSON", async () => {
    await writeFile(
      join(dir, "keybindings.json"),
      JSON.stringify([
        { key: "cmd+k", command: "-output.clear" },
        { key: "cmd+??", command: "run.start" },
      ]),
    );
    expect((await KeybindingsStore.open(dir)).rules).toEqual([{ key: "cmd+k", command: "-output.clear" }]);
    await writeFile(join(dir, "keybindings.json"), "[{oops");
    const broken = await KeybindingsStore.open(dir);
    expect([broken.rules, broken.invalid]).toEqual([[], true]);
  });

  test("saves rules atomically, keeps them in memory and notifies listeners", async () => {
    const store = await KeybindingsStore.open(dir);
    const seen: number[] = [];
    const stop = store.onChange((rules) => seen.push(rules.length));
    await store.save([{ key: "cmd+shift+k", command: "output.clear" }]);
    expect([...store.rules]).toEqual([{ key: "cmd+shift+k", command: "output.clear" }]);
    expect(JSON.parse(await readFile(join(dir, "keybindings.json"), "utf8"))).toEqual([
      { key: "cmd+shift+k", command: "output.clear" },
    ]);
    stop();
    await store.save([]);
    expect(seen).toEqual([1]);
    expect([...store.rules]).toEqual([]);
  });

  // Pins the serialization itself: every other assertion here round-trips through JSON.parse, so dropping the
  // pretty-printing or the trailing newline would survive all of them.
  test("the saved file is pretty-printed with a trailing newline", async () => {
    const store = await KeybindingsStore.open(dir);
    await store.save([{ key: "cmd+shift+k", command: "output.clear" }]);
    expect(await readFile(join(dir, "keybindings.json"), "utf8")).toBe(
      `[\n  {\n    "key": "cmd+shift+k",\n    "command": "output.clear"\n  }\n]\n`,
    );
  });

  test("a save drops rules the read path would reject, so the file can never hold what we'd ignore", async () => {
    const store = await KeybindingsStore.open(dir);
    await store.save([
      { key: "cmd+shift+k", command: "output.clear" },
      { key: "cmd+??", command: "run.start" },
      { key: "cmd+j", command: "not.a.command" },
    ] as never);
    expect([...store.rules]).toEqual([{ key: "cmd+shift+k", command: "output.clear" }]);
    expect((await KeybindingsStore.open(dir)).rules).toEqual([{ key: "cmd+shift+k", command: "output.clear" }]);
  });

  // The dropped rules must not reach the listeners either, or the running app would show a binding the file does
  // not hold. Asserting only `store.rules` above would miss a save that notified with the raw input.
  test("listeners receive the validated set, not the raw input", async () => {
    const store = await KeybindingsStore.open(dir);
    const seen: unknown[] = [];
    store.onChange((rules) => seen.push([...rules]));
    await store.save([
      { key: "cmd+shift+k", command: "output.clear" },
      { key: "cmd+??", command: "run.start" },
    ] as never);
    expect(seen).toEqual([[{ key: "cmd+shift+k", command: "output.clear" }]]);
  });

  test("a reopened store sees what the previous one saved", async () => {
    const first = await KeybindingsStore.open(dir);
    await first.save([{ key: "cmd+k", command: "-output.clear" }]);
    expect([...(await KeybindingsStore.open(dir)).rules]).toEqual([{ key: "cmd+k", command: "-output.clear" }]);
  });

  // Pins `{ backup: true }`: the contents a save replaces survive as <path>.bak.
  test("a save backs up the file it replaces", async () => {
    const store = await KeybindingsStore.open(dir);
    await store.save([{ key: "cmd+k", command: "-output.clear" }]);
    await store.save([{ key: "cmd+j", command: "run.start" }]);
    expect(JSON.parse(await readFile(join(dir, "keybindings.json.bak"), "utf8"))).toEqual([
      { key: "cmd+k", command: "-output.clear" },
    ]);
  });

  test("onChange notifies every listener and unsubscribes only the one returned", async () => {
    const store = await KeybindingsStore.open(dir);
    const a: number[] = [];
    const b: number[] = [];
    const stopA = store.onChange((rules) => a.push(rules.length));
    store.onChange((rules) => b.push(rules.length));
    await store.save([{ key: "cmd+j", command: "run.start" }]);
    stopA();
    await store.save([]);
    expect([a, b]).toEqual([[1], [1, 0]]);
  });

  // A failed write must leave both the in-memory rules and the listeners untouched, or the running app would
  // drift away from what the file actually holds. Replacing the file with a DIRECTORY makes the backup copy fail
  // with EISDIR rather than the ENOENT a first-ever save legitimately swallows -- deterministic, and it does not
  // depend on the uid the suite happens to run as.
  test("a failed write leaves the in-memory rules alone and notifies nobody", async () => {
    const store = await KeybindingsStore.open(dir);
    await store.save([{ key: "cmd+j", command: "run.start" }]);
    const seen: number[] = [];
    store.onChange((rules) => seen.push(rules.length));
    await rm(join(dir, "keybindings.json"));
    await mkdir(join(dir, "keybindings.json"));
    await expect(store.save([])).rejects.toThrow();
    expect([[...store.rules], seen]).toEqual([[{ key: "cmd+j", command: "run.start" }], []]);
  });
});
