import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createTab,
  defaultSession,
  defaultSettings,
  SETTINGS_VERSION,
  sessionSchema,
  settingsSchema,
} from "@jslab/shared";
import {
  consumeSafeModeFlag,
  detectSafeMode,
  isShiftHeld,
  requestSafeModeOnNextLaunch,
  SHIFT_MASK,
} from "../../src/main/services/safe-mode";
import { SessionStore } from "../../src/main/services/session-store";
import { MAX_SETTINGS_BYTES, SettingsStore } from "../../src/main/services/settings-store";

let dir = "";
// Tracks every SessionStore opened in a test so afterEach can flush its debounced writer before removing dir: an
// unflushed schedule() timer that fires after rm() would recreate dir via writeFileAtomic's mkdir (R-M2-T3-1).
let sessionStores: SessionStore[] = [];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jslab-services-"));
  sessionStores = [];
});
afterEach(async () => {
  await Promise.all(sessionStores.map((store) => store.flush()));
  await rm(dir, { recursive: true, force: true });
});

async function openSession(options?: Parameters<typeof SessionStore.open>[1]): Promise<SessionStore> {
  const store = await SessionStore.open(dir, options);
  sessionStores.push(store);
  return store;
}

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
    expect(JSON.parse(await readFile(join(dir, "settings.json"), "utf8")).version).toBe(SETTINGS_VERSION);
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

  test("overlapping writes land in order, so a slow first write can't overwrite a later update; flush awaits it (FA-I1)", async () => {
    const { writeFileAtomic } = await import("../../src/main/persistence/atomic-write");
    let calls = 0;
    let firstLanded = false;
    const store = await SettingsStore.open(dir, {
      write: async (path, data, options) => {
        calls++;
        if (calls === 1) {
          // The first write (uiScale 1.25) is slow, like an fsync that finishes after the next write starts.
          await Bun.sleep(80);
          await writeFileAtomic(path, data, options);
          firstLanded = true;
          return;
        }
        await writeFileAtomic(path, data, options);
      },
    });
    const first = store.update({ appearance: { uiScale: 1.25 } });
    const second = store.update({ appearance: { uiScale: 1.5 } });
    await store.flush();
    expect(firstLanded).toBe(true);
    await Promise.all([first, second]);
    expect(JSON.parse(await readFile(join(dir, "settings.json"), "utf8")).appearance.uiScale).toBe(1.5);
    // Reset goes through the same writer.
    const reset = store.reset();
    await store.flush();
    expect(JSON.parse(await readFile(join(dir, "settings.json"), "utf8")).appearance.uiScale).toBe(1);
    await reset;
  });

  test("an update resolves with the current settings, including a change made while its write was queued (Seat B cross-seat 4)", async () => {
    const store = await SettingsStore.open(dir);
    // The main window's zoom and a Settings-window font change overlap: neither response may roll the other back.
    const zoom = store.update({ appearance: { uiScale: 1.25 } });
    const font = store.update({ appearance: { fontSize: 18 } });
    const [first, second] = await Promise.all([zoom, font]);
    expect([first.appearance.uiScale, first.appearance.fontSize]).toEqual([1.25, 18]);
    expect(first).toBe(store.current);
    expect(second).toBe(store.current);
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

  test("a hung write times out and is reported, later updates still land, and the late write never commits (RR1-m2)", async () => {
    const { writeFileAtomic } = await import("../../src/main/persistence/atomic-write");
    const errors: unknown[] = [];
    let calls = 0;
    let releaseFirst: () => void = () => {};
    // The first write's own promise, so the test waits for it to finish instead of sleeping.
    let firstWrite: Promise<void> = Promise.resolve();
    const store = await SettingsStore.open(dir, {
      writeTimeoutMs: 250,
      onWriteError: (error) => errors.push(error),
      write: (path, data, options) => {
        calls++;
        if (calls !== 1) return writeFileAtomic(path, data, options);
        firstWrite = new Promise<void>((resolve) => {
          releaseFirst = resolve;
        }).then(() => writeFileAtomic(path, data, options));
        return firstWrite;
      },
    });
    await expect(store.update({ appearance: { uiScale: 1.25 } })).rejects.toThrow("did not finish within 250 ms");
    expect(await store.update({ appearance: { uiScale: 1.5 } })).toBe(store.current);
    releaseFirst();
    await firstWrite;
    expect(JSON.parse(await readFile(join(dir, "settings.json"), "utf8")).appearance.uiScale).toBe(1.5);
    expect(errors).toHaveLength(1);
  });

  test("never writes a settings.json its own reader would refuse (R-M4-BOUNDED-6)", async () => {
    // `settingsSchema` is a `z.looseObject`, and so is every `section()` in it, deliberately: unknown keys from a
    // newer build are passed through rather than discarded. They survive parse, survive mergeSettings, and reach
    // the snapshot -- and the snapshot is pretty-printed, which EXPANDS (measured ~1.17x here). So a settings.json
    // this reader ACCEPTS can be rewritten by JSLab itself at over the cap, after which the next launch reads it
    // as corrupt and silently falls back, losing the change the user just made. A writer must not produce a file
    // its own reader refuses.
    const unknown: Record<string, unknown> = {};
    for (let index = 0; index < 25_000; index++) unknown[`experimentalFeatureFlag${index}`] = index;
    const base = defaultSettings();
    const onDisk = JSON.stringify({ ...base, run: { ...base.run, ...unknown } });
    // The premise: this file is one the reader accepts, so nothing is wrong with it at load.
    expect(Buffer.byteLength(onDisk, "utf8")).toBeLessThanOrEqual(MAX_SETTINGS_BYTES);
    await writeFile(join(dir, "settings.json"), onDisk);

    const errors: unknown[] = [];
    const store = await SettingsStore.open(dir, { onWriteError: (error) => errors.push(error) });
    expect("experimentalFeatureFlag0" in (store.current.run as Record<string, unknown>)).toBe(true);

    await store.update({ editor: { lineWrap: false } });
    await store.flush();

    // Refused, not truncated and not written anyway: what is on disk is still a file this app can load.
    const written = await readFile(join(dir, "settings.json"), "utf8");
    expect(Buffer.byteLength(written, "utf8")).toBeLessThanOrEqual(MAX_SETTINGS_BYTES);
    // Refused loudly, through the same channel every other failed settings write already reports on.
    expect(errors).toHaveLength(1);

    // The point of all of it: the next launch is an ordinary one, and the newer build's keys are still there.
    const reopened = await SettingsStore.open(dir);
    expect([reopened.recovered, reopened.primary]).toEqual(["none", "ok"]);
    expect("experimentalFeatureFlag0" in (reopened.current.run as Record<string, unknown>)).toBe(true);
  });
});

describe("SessionStore", () => {
  test("creates a default session with one tab", async () => {
    const store = await openSession({ newTab: () => createTab({ id: "t1" }) });
    expect(store.session.tabOrder).toEqual(["t1"]);
    expect(await store.readBuffers()).toEqual({ t1: "" });
  });

  test("debounces buffer writes and restores them", async () => {
    const store = await openSession({ newTab: () => createTab({ id: "t1" }), delayMs: 20 });
    store.setBuffer("t1", "const a = 1");
    store.setBuffer("t1", "const a = 2");
    await store.flush();
    expect(await readFile(join(dir, "buffers", "t1.ts"), "utf8")).toBe("const a = 2");
    const reopened = await openSession();
    expect(await reopened.readBuffers()).toEqual({ t1: "const a = 2" });
  });

  test("renames the buffer file when the language changes", async () => {
    const store = await openSession({ newTab: () => createTab({ id: "t1" }), delayMs: 20 });
    store.setBuffer("t1", "<div />");
    await store.patchTab("t1", { language: "tsx" });
    await store.flush();
    expect(existsSync(join(dir, "buffers", "t1.ts"))).toBe(false);
    expect(await readFile(join(dir, "buffers", "t1.tsx"), "utf8")).toBe("<div />");
    expect((await openSession()).session.tabs.t1?.language).toBe("tsx");
  });

  test("persists the window frame and clamps one smaller than 400×300 (FA-m6)", async () => {
    const store = await openSession({ delayMs: 20 });
    store.setWindow({ x: 10, y: 20, width: 1200, height: 800 });
    await store.flush();
    expect((await openSession()).session.window).toEqual({ x: 10, y: 20, width: 1200, height: 800 });
    store.setWindow({ x: 0, y: 0, width: 5, height: 5 });
    expect(store.session.window).toEqual({ x: 0, y: 0, width: 400, height: 300 });
  });

  test("an unreadable buffer is surfaced instead of read as empty", async () => {
    const store = await openSession({ newTab: () => createTab({ id: "t1" }) });
    // A directory where the buffer file should be: reading it fails with EISDIR, not ENOENT.
    await mkdir(join(dir, "buffers", "t1.ts"), { recursive: true });
    await expect(store.readBuffers()).rejects.toThrow("t1");
  });

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "a buffer that could not be read is never overwritten",
    async () => {
      const store = await openSession({ newTab: () => createTab({ id: "t1" }), delayMs: 5 });
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
    const store = await openSession({ newTab: () => createTab({ id: "t1" }) });
    expect(store.recovered).not.toBe("none");
    const onDisk = JSON.parse(await readFile(join(dir, "session.json"), "utf8"));
    expect(sessionSchema.parse(onDisk)).toEqual(onDisk);
  });

  test("the session is serialized when it is written, so every commit before the write lands (FA-m9)", async () => {
    const store = await openSession({ delayMs: 10_000 });
    const id = store.session.activeTabId;
    const stringify = spyOn(JSON, "stringify");
    for (let i = 0; i < 50; i++) store.setViewState(id, { scrollTop: i });
    expect(stringify).not.toHaveBeenCalled();
    stringify.mockRestore();
    await store.flush();
    expect(JSON.parse(await readFile(join(dir, "session.json"), "utf8")).tabs[id].viewState).toEqual({ scrollTop: 49 });
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
    const sessionStore = await openSession({ newTab: () => createTab({ id: "t1" }) });
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
    const store = await openSession({ delayMs: 10 });
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
    const store = await openSession({ delayMs: 10 });
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
        store = await openSession({ delayMs: 10 });
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

  test("a manual restart request is consumed once and ranks between crash loop and shift", async () => {
    requestSafeModeOnNextLaunch(dir);
    expect(consumeSafeModeFlag(dir)).toBe(true);
    expect(consumeSafeModeFlag(dir)).toBe(false);
    const shift = async () => true;
    expect(await detectSafeMode({ uncleanPreviousExit: false, manualRequested: true, shiftHeld: shift })).toEqual({
      active: true,
      reason: "manual",
    });
    expect(await detectSafeMode({ uncleanPreviousExit: true, manualRequested: true, shiftHeld: shift })).toEqual({
      active: true,
      reason: "crashLoop",
    });
  });
});
