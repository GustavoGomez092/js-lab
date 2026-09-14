import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTab, defaultSession, defaultSettings, sessionSchema, settingsSchema } from "@jslab/shared";
import { detectSafeMode, isShiftHeld, SHIFT_MASK } from "../../src/main/services/safe-mode";
import { SessionStore } from "../../src/main/services/session-store";
import { SettingsStore } from "../../src/main/services/settings-store";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jslab-services-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("SettingsStore", () => {
  test("starts from defaults and persists updates", async () => {
    const store = await SettingsStore.open(dir);
    expect(store.current.run.autoRun).toBe(true);
    const seen: boolean[] = [];
    store.onChange((s) => seen.push(s.run.autoRun));
    await store.update({ run: { autoRun: false } });
    expect(seen).toEqual([false]);
    const reopened = await SettingsStore.open(dir);
    expect(reopened.current.run.autoRun).toBe(false);
  });

  test("repairs a corrupt file from defaults and rewrites it", async () => {
    await writeFile(join(dir, "settings.json"), "{oops");
    const store = await SettingsStore.open(dir);
    expect(store.recovered).toBe("defaults");
    expect(JSON.parse(await readFile(join(dir, "settings.json"), "utf8")).run.autoRun).toBe(true);
  });

  test("migrates an M1 settings file on open and rewrites it at version 2", async () => {
    await writeFile(
      join(dir, "settings.json"),
      JSON.stringify({ version: 1, run: { autoRun: false }, appearance: { theme: "dracula", fontSize: 16 } }),
    );
    const store = await SettingsStore.open(dir);
    expect(store.recovered).toBe("none");
    expect(store.current.appearance).toMatchObject({ theme: "graphite", fontSize: 16 });
    expect(store.current.run.autoRun).toBe(false);
    expect(JSON.parse(await readFile(join(dir, "settings.json"), "utf8")).version).toBe(2);
  });

  test("reset restores defaults, persists them and notifies listeners", async () => {
    const store = await SettingsStore.open(dir);
    await store.update({ editor: { lineWrap: false } });
    const seen: boolean[] = [];
    store.onChange((s) => seen.push(s.editor.lineWrap));
    await store.reset();
    expect(seen).toEqual([true]);
    expect((await SettingsStore.open(dir)).current.editor.lineWrap).toBe(true);
  });

  test("a settings file from a newer JSLab is used but never overwritten (final review I4)", async () => {
    const text = JSON.stringify({ version: 99, editor: { lineWrap: false }, future: { flag: true } });
    await writeFile(join(dir, "settings.json"), text);
    const store = await SettingsStore.open(dir);
    expect([store.newerVersion, store.current.editor.lineWrap]).toEqual([99, false]);
    await store.update({ view: { statusBar: false } });
    expect(store.current.view.statusBar).toBe(false);
    expect(await readFile(join(dir, "settings.json"), "utf8")).toBe(text);
  });
});

describe("SessionStore", () => {
  test("creates a default session with one tab", async () => {
    const store = await SessionStore.open(dir, { newTab: () => createTab({ id: "t1" }) });
    expect(store.session.tabOrder).toEqual(["t1"]);
    expect(await store.readBuffers()).toEqual({ t1: "" });
  });

  test("debounces buffer writes and restores them", async () => {
    const store = await SessionStore.open(dir, { newTab: () => createTab({ id: "t1" }), delayMs: 20 });
    store.setBuffer("t1", "const a = 1");
    store.setBuffer("t1", "const a = 2");
    await store.flush();
    expect(await readFile(join(dir, "buffers", "t1.ts"), "utf8")).toBe("const a = 2");
    const reopened = await SessionStore.open(dir);
    expect(await reopened.readBuffers()).toEqual({ t1: "const a = 2" });
  });

  test("renames the buffer file when the language changes", async () => {
    const store = await SessionStore.open(dir, { newTab: () => createTab({ id: "t1" }), delayMs: 20 });
    store.setBuffer("t1", "<div />");
    await store.patchTab("t1", { language: "tsx" });
    await store.flush();
    expect(existsSync(join(dir, "buffers", "t1.ts"))).toBe(false);
    expect(await readFile(join(dir, "buffers", "t1.tsx"), "utf8")).toBe("<div />");
    expect((await SessionStore.open(dir)).session.tabs.t1?.language).toBe("tsx");
  });

  test("persists the window frame and ignores invalid frames", async () => {
    const store = await SessionStore.open(dir, { delayMs: 20 });
    store.setWindow({ x: 10, y: 20, width: 1200, height: 800 });
    await store.flush();
    expect((await SessionStore.open(dir)).session.window).toEqual({ x: 10, y: 20, width: 1200, height: 800 });
    store.setWindow({ x: 0, y: 0, width: 5, height: 5 });
    expect(store.session.window).toBeNull();
  });

  test("an unreadable buffer is surfaced instead of read as empty", async () => {
    const store = await SessionStore.open(dir, { newTab: () => createTab({ id: "t1" }) });
    // A directory where the buffer file should be: reading it fails with EISDIR, not ENOENT.
    await mkdir(join(dir, "buffers", "t1.ts"), { recursive: true });
    await expect(store.readBuffers()).rejects.toThrow("t1");
  });

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "a buffer that could not be read is never overwritten",
    async () => {
      const store = await SessionStore.open(dir, { newTab: () => createTab({ id: "t1" }), delayMs: 5 });
      const path = join(dir, "buffers", "t1.ts");
      await mkdir(join(dir, "buffers"), { recursive: true });
      await writeFile(path, "precious");
      await chmod(path, 0o000);
      try {
        await expect(store.readBuffers()).rejects.toThrow();
        store.setBuffer("t1", "");
        await store.flush();
      } finally {
        await chmod(path, 0o600);
      }
      expect(await readFile(path, "utf8")).toBe("precious");
    },
  );

  test("session recovery rewrites a valid session file", async () => {
    await writeFile(join(dir, "session.json"), "{oops");
    const store = await SessionStore.open(dir, { newTab: () => createTab({ id: "t1" }) });
    expect(store.recovered).not.toBe("none");
    const onDisk = JSON.parse(await readFile(join(dir, "session.json"), "utf8"));
    expect(sessionSchema.parse(onDisk)).toEqual(onDisk);
  });
});

describe("recovery preserves backups", () => {
  test("recovery from a backup leaves the backup intact", async () => {
    const validSettings = defaultSettings();
    await writeFile(join(dir, "settings.json.bak"), JSON.stringify(validSettings));
    await writeFile(join(dir, "settings.json"), "{oops");
    const settingsStore = await SettingsStore.open(dir);
    expect(settingsStore.recovered).toBe("backup");
    const settingsBackup = JSON.parse(await readFile(join(dir, "settings.json.bak"), "utf8"));
    expect(settingsSchema.parse(settingsBackup)).toEqual(settingsBackup);
    expect(settingsBackup.run.autoRun).toBe(true);

    const validSession = defaultSession(() => createTab({ id: "t1" }));
    await writeFile(join(dir, "session.json.bak"), JSON.stringify(validSession));
    await writeFile(join(dir, "session.json"), "{oops");
    const sessionStore = await SessionStore.open(dir, { newTab: () => createTab({ id: "t1" }) });
    expect(sessionStore.recovered).toBe("backup");
    const sessionBackup = JSON.parse(await readFile(join(dir, "session.json.bak"), "utf8"));
    expect(sessionSchema.parse(sessionBackup)).toEqual(sessionBackup);
    expect(sessionBackup.tabOrder).toEqual(["t1"]);
  });

  test("a session file from a newer JSLab is read and reported but never overwritten; one bad tab is skipped (I4)", async () => {
    const path = join(dir, "session.json");
    const text = JSON.stringify({
      version: 99,
      window: null,
      tabOrder: ["a", "bad"],
      activeTabId: "a",
      tabs: { a: { id: "a", title: "kept" }, bad: { title: "no id" } },
      workspaces: [{ id: "w1" }],
    });
    await writeFile(path, text);
    const store = await SessionStore.open(dir, { delayMs: 10 });
    expect([store.newerVersion, store.droppedTabs, store.session.tabOrder]).toEqual([99, ["bad"], ["a"]]);
    store.setWindow({ x: 1, y: 2, width: 800, height: 600 });
    await store.flush();
    expect(await readFile(path, "utf8")).toBe(text);
  });

  test("a hand-edited tab id outside the safe format is repaired on load and keeps its buffer (R-M1-18)", async () => {
    await mkdir(join(dir, "buffers"), { recursive: true });
    await writeFile(join(dir, "buffers", "my tab.ts"), "kept");
    await writeFile(
      join(dir, "session.json"),
      JSON.stringify({ version: 2, tabOrder: ["my tab"], activeTabId: "my tab", tabs: { "my tab": { id: "my tab" } } }),
    );
    const store = await SessionStore.open(dir, { delayMs: 10 });
    const [id = ""] = store.session.tabOrder;
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(await store.readBuffers()).toEqual({ [id]: "kept" });
    expect(existsSync(join(dir, "buffers", "my tab.ts"))).toBe(false);
    expect(JSON.parse(await readFile(join(dir, "session.json"), "utf8")).tabOrder).toEqual([id]);
  });

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "a repaired tab's buffer move failure (not ENOENT) is surfaced, not silently read as empty (fix round 1)",
    async () => {
      await mkdir(join(dir, "buffers"), { recursive: true });
      await writeFile(join(dir, "buffers", "my tab.ts"), "kept");
      await writeFile(
        join(dir, "session.json"),
        JSON.stringify({
          version: 2,
          tabOrder: ["my tab"],
          activeTabId: "my tab",
          tabs: { "my tab": { id: "my tab" } },
        }),
      );
      // No write permission on buffers/: the repair rename fails with EACCES, not ENOENT, and nothing is moved.
      await chmod(join(dir, "buffers"), 0o500);
      let store: SessionStore;
      try {
        store = await SessionStore.open(dir, { delayMs: 10 });
      } finally {
        await chmod(join(dir, "buffers"), 0o700);
      }
      const [id = ""] = store.session.tabOrder;
      expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
      await expect(store.readBuffers()).rejects.toThrow(`Couldn't read the buffer for tab ${id}`);
      expect(await readFile(join(dir, "buffers", "my tab.ts"), "utf8")).toBe("kept");
      store.setBuffer(id, "x");
      await store.flush();
      expect(existsSync(join(dir, "buffers", `${id}.ts`))).toBe(false);
    },
  );
});

describe("safe mode", () => {
  test("an unclean previous exit wins over the shift check", async () => {
    let asked = false;
    const state = await detectSafeMode({
      uncleanPreviousExit: true,
      shiftHeld: async () => {
        asked = true;
        return true;
      },
    });
    expect(state).toEqual({ active: true, reason: "crashLoop" });
    expect(asked).toBe(false);
  });

  test("holding shift enables safe mode", async () => {
    expect(await detectSafeMode({ uncleanPreviousExit: false, shiftHeld: async () => true })).toEqual({
      active: true,
      reason: "shift",
    });
    expect(await detectSafeMode({ uncleanPreviousExit: false, shiftHeld: async () => false })).toEqual({
      active: false,
      reason: null,
    });
  });

  test("isShiftHeld parses modifier flags and never throws", async () => {
    expect(await isShiftHeld(async () => `${SHIFT_MASK | 256}\n`)).toBe(true);
    expect(await isShiftHeld(async () => "256\n")).toBe(false);
    expect(await isShiftHeld(async () => "garbage")).toBe(false);
    expect(await isShiftHeld(() => new Promise(() => {}), 20)).toBe(false);
    expect(await isShiftHeld(async () => Promise.reject(new Error("no osascript")))).toBe(false);
  });

  test.skipIf(process.platform !== "darwin")("reads real modifier flags on macOS", async () => {
    expect(typeof (await isShiftHeld())).toBe("boolean");
  });
});
