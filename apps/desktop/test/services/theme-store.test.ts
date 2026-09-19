import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convertVsCodeTheme } from "@jslab/themes";
import { ThemeStore } from "../../src/main/services/theme-store";

let dir = "";
const logged: string[] = [];
const log = (message: string) => {
  logged.push(message);
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jslab-themes-"));
  logged.length = 0;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function theme(name: string) {
  const result = convertVsCodeTheme({ name, type: "dark", colors: { "editor.background": "#101010" } });
  if (!result.ok) throw new Error(result.error);
  return result.theme;
}

/** Writes `body` as the only file in a fresh themes folder and reports what `ThemeStore.open` made of it. */
async function loadOnly(themesDir: string, body: unknown): Promise<ThemeStore> {
  await rm(themesDir, { recursive: true, force: true });
  await mkdir(themesDir, { recursive: true });
  await writeFile(join(themesDir, "candidate.jslab-theme.json"), JSON.stringify(body));
  return await ThemeStore.open(themesDir, log);
}

describe("ThemeStore", () => {
  test("a missing folder means no themes, and creates nothing until a save", async () => {
    const store = await ThemeStore.open(join(dir, "themes"), log);
    expect(store.themes).toEqual([]);
    expect(store.dir).toBe(join(dir, "themes"));
    // A fresh install has imported nothing: opening the store must not create the folder, and must not log.
    await expect(readdir(dir)).resolves.toEqual([]);
    expect(logged).toEqual([]);
  });

  test("saves as <id>.jslab-theme.json and reloads it unchanged on the next open (spec §4.5)", async () => {
    const themesDir = join(dir, "themes");
    const store = await ThemeStore.open(themesDir, log);
    const saved = theme("Deep Dark");
    await store.save(saved);
    expect(await readdir(themesDir)).toEqual(["deep-dark.jslab-theme.json"]);
    const written = JSON.parse(await readFile(join(themesDir, "deep-dark.jslab-theme.json"), "utf8"));
    expect(written).toMatchObject({ id: "deep-dark", name: "Deep Dark", type: "dark" });
    expect(written.tokens["bg.canvas"]).toMatch(/^#[0-9A-F]{6}$/);
    expect(store.themes).toEqual([saved]);

    // Round-trip identity: every field the app reads survives the write and the re-parse, not just the three above.
    const reopened = await ThemeStore.open(themesDir, log);
    expect(reopened.themes).toEqual([saved]);
    expect(logged).toEqual([]);
  });

  test("re-saving the same id replaces it instead of adding a duplicate", async () => {
    const themesDir = join(dir, "themes");
    const store = await ThemeStore.open(themesDir, log);
    const first = theme("Deep Dark");
    const second = { ...first, name: "Deep Dark II" };
    await store.save(first);
    await store.save(second);
    expect(store.themes).toEqual([second]);
    expect(await readdir(themesDir)).toHaveLength(1);
    expect((await ThemeStore.open(themesDir, log)).themes).toEqual([second]);
  });

  test("themes load in file-name order, whatever order they were saved in", async () => {
    const themesDir = join(dir, "themes");
    const store = await ThemeStore.open(themesDir, log);
    // Saved in reverse. `readdir` hands back an APFS directory in name-hash order, not name order (measured: a
    // two-file folder can come back sorted by luck, ten files do not), so the store has to sort for itself.
    const ids = Array.from({ length: 10 }, (_, index) => `t${9 - index}`);
    for (const id of ids) await store.save(theme(id.toUpperCase()));
    const reopened = await ThemeStore.open(themesDir, log);
    expect(reopened.themes.map((entry) => entry.id)).toEqual([...ids].sort());
  });

  test("notifies listeners on save and stops after unsubscribe", async () => {
    const store = await ThemeStore.open(join(dir, "themes"), log);
    const seen: string[][] = [];
    const stop = store.onChange((themes) => seen.push(themes.map((entry) => entry.id)));
    await store.save(theme("A"));
    stop();
    await store.save(theme("B"));
    // The listener is handed the whole current set, and hears nothing after it unsubscribes.
    expect(seen).toEqual([["a"]]);
    expect(store.themes.map((entry) => entry.id)).toEqual(["a", "b"]);
  });

  test("unsubscribing one listener leaves the others subscribed", async () => {
    const store = await ThemeStore.open(join(dir, "themes"), log);
    const first: number[] = [];
    const second: number[] = [];
    const stop = store.onChange((themes) => first.push(themes.length));
    store.onChange((themes) => second.push(themes.length));
    stop();
    await store.save(theme("A"));
    expect([first, second]).toEqual([[], [1]]);
  });

  test("an unreadable or invalid theme file is skipped and logged, never fatal", async () => {
    const themesDir = join(dir, "themes");
    const store = await ThemeStore.open(themesDir, log);
    await store.save(theme("Good"));
    await writeFile(join(themesDir, "broken.jslab-theme.json"), "{not json");
    await writeFile(join(themesDir, "wrong-shape.jslab-theme.json"), JSON.stringify({ id: "x" }));
    await writeFile(join(themesDir, "ignored.txt"), "not a theme");
    logged.length = 0;
    const reopened = await ThemeStore.open(themesDir, log);
    expect(reopened.themes.map((entry) => entry.id)).toEqual(["good"]);
    // Exactly the two malformed theme files: the good one and the non-theme file are not reported.
    expect(logged).toHaveLength(2);
    expect(logged.join("\n")).toContain("broken.jslab-theme.json");
    expect(logged.join("\n")).toContain("wrong-shape.jslab-theme.json");
    expect(logged.join("\n")).not.toContain("ignored.txt");
    expect(logged.join("\n")).not.toContain("good.jslab-theme.json");
  });

  test("a hand-edited theme is accepted only while every field it declares is still valid", async () => {
    const themesDir = join(dir, "themes");
    const valid = theme("Good");
    const withTokens = (patch: Record<string, unknown>) => ({ ...valid, tokens: { ...valid.tokens, ...patch } });
    const withMonaco = (patch: Record<string, unknown>) => ({ ...valid, monaco: { ...valid.monaco, ...patch } });
    const cases: [string, unknown][] = [
      ["not an object at all", "nope"],
      ["null", null],
      ["an array", []],
      ["no id", { ...valid, id: undefined }],
      ["an id that would escape the folder", { ...valid, id: "../evil" }],
      ["an id longer than 64 characters", { ...valid, id: "x".repeat(65) }],
      ["a blank name", { ...valid, name: "   " }],
      ["a name that isn't a string", { ...valid, name: 42 }],
      ["an unknown type", { ...valid, type: "sepia" }],
      ["no credit", { ...valid, credit: undefined }],
      ["no tokens", { ...valid, tokens: null }],
      ["a token that isn't a hex colour", withTokens({ "bg.canvas": "red" })],
      ["a token that is an 8-digit hex", withTokens({ "bg.canvas": "#101010FF" })],
      ["a missing token", withTokens({ "syntax.function": undefined })],
      ["no monaco section", { ...valid, monaco: undefined }],
      ["an unknown monaco base", withMonaco({ base: "hc-black" })],
      ["monaco.inherit that isn't true", withMonaco({ inherit: false })],
      ["monaco.rules that isn't an array", withMonaco({ rules: {} })],
      ["a monaco rule with no token name", withMonaco({ rules: [{ foreground: "#FFFFFF" }] })],
      ["no monaco.colors", withMonaco({ colors: undefined })],
      // Not just "missing": an array and a string both survive `Object.values`, so only an object will do.
      ["monaco.colors as an array", withMonaco({ colors: [] })],
      ["monaco.colors as a string", withMonaco({ colors: "abc" })],
      ["a monaco colour that isn't a string", withMonaco({ colors: { "editor.background": 1 } })],
    ];
    for (const [label, body] of cases) {
      const store = await loadOnly(themesDir, body);
      expect([label, store.themes]).toEqual([label, []]);
    }
    // The control: without any of those edits the very same file loads, so the refusals above are real refusals
    // and not a parser that rejects everything.
    expect((await loadOnly(themesDir, valid)).themes).toEqual([valid]);
  });

  test("save refuses an id that isn't a safe file name, and writes nothing", async () => {
    const themesDir = join(dir, "themes");
    const store = await ThemeStore.open(themesDir, log);
    await expect(store.save({ ...theme("Good"), id: "../escape" })).rejects.toThrow();
    expect(store.themes).toEqual([]);
    await expect(readdir(dir)).resolves.toEqual([]);
  });
});
