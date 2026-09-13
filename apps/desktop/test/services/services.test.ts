import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTab, sessionSchema } from "@jslab/shared";
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

  test("session recovery rewrites a valid session file", async () => {
    await writeFile(join(dir, "session.json"), "{oops");
    const store = await SessionStore.open(dir, { newTab: () => createTab({ id: "t1" }) });
    expect(store.recovered).not.toBe("none");
    const onDisk = JSON.parse(await readFile(join(dir, "session.json"), "utf8"));
    expect(sessionSchema.parse(onDisk)).toEqual(onDisk);
  });
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
