import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
});
