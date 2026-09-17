import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTab, type Session } from "@jslab/shared";
import { SessionStore } from "../../src/main/services/session-store";

let dir = "";
// Tracks every store opened in a test so afterEach can flush its debounced writer before removing dir: an
// unflushed schedule() timer that fires after rm() would recreate dir via writeFileAtomic's mkdir (R-M2-T3-1).
let stores: SessionStore[] = [];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jslab-tabs-"));
  stores = [];
});
afterEach(async () => {
  await Promise.all(stores.map((store) => store.flush()));
  await rm(dir, { recursive: true, force: true });
});

const open = async (extra: Parameters<typeof SessionStore.open>[1] = {}) => {
  const store = await SessionStore.open(dir, { newTab: () => createTab({ id: "t1" }), delayMs: 10, ...extra });
  stores.push(store);
  return store;
};

describe("SessionStore tabs", () => {
  test("createTab applies defaults, inserts after the active tab, activates it and writes its buffer", async () => {
    const store = await open({
      tabDefaults: () => ({
        language: "javascript",
        layout: {
          orientation: "vertical",
          editorSize: 55,
          outputVisible: true,
          tiles: { webviewVisible: false, consoleSize: 55 },
          muted: false,
        },
      }),
    });
    const second = await store.createTab({ content: "1 + 1" });
    store.activateTab("t1");
    const third = await store.createTab({ language: "tsx", title: "Mine", titleIsCustom: true });
    expect(store.session.tabOrder).toEqual(["t1", third.id, second.id]);
    expect(store.session.activeTabId).toBe(third.id);
    expect(second).toMatchObject({ language: "javascript", layout: { orientation: "vertical" } });
    expect(third).toMatchObject({ language: "tsx", title: "Mine", titleIsCustom: true });
    expect(await readFile(join(dir, "buffers", `${second.id}.js`), "utf8")).toBe("1 + 1");
    const background = await store.createTab({ activate: false });
    expect(store.session.activeTabId).toBe(third.id);
    expect(store.session.tabOrder).toContain(background.id);
  });

  test("closeTab moves the buffer to closed/, activates the right neighbor, and replaces the last tab", async () => {
    const store = await open();
    const b = await store.createTab({ content: "b" });
    store.activateTab("t1");
    store.setBuffer("t1", "one");
    expect(await store.closeTab("t1")).toEqual({ closed: true, replacement: null, activeTabId: b.id });
    expect(await readFile(join(dir, "buffers", "closed", "t1.ts"), "utf8")).toBe("one");
    expect(existsSync(join(dir, "buffers", "t1.ts"))).toBe(false);
    expect(store.session.closedStack.map((entry) => entry.tab.id)).toEqual(["t1"]);

    const last = await store.closeTab(b.id);
    expect(last.closed).toBe(true);
    expect(last.replacement).not.toBeNull();
    expect([last.replacement?.id]).toEqual(store.session.tabOrder);
    expect(await store.closeTab("missing")).toMatchObject({ closed: false, replacement: null });
  });

  test("reopenClosed restores the newest tab with its content after the active tab", async () => {
    const store = await open();
    const b = await store.createTab({ content: "bee" });
    await store.createTab({ content: "sea" });
    await store.closeTab(b.id);
    store.activateTab("t1");
    const reopened = await store.reopenClosed();
    expect(reopened).toEqual({ tab: expect.objectContaining({ id: b.id }), content: "bee" });
    expect(store.session.tabOrder[1]).toBe(b.id);
    expect(store.session.activeTabId).toBe(b.id);
    expect(store.session.closedStack).toEqual([]);
    expect(await store.reopenClosed()).toBeNull();
  });

  test("buffers of tabs evicted past 20 closed tabs are deleted", async () => {
    const store = await open();
    const ids: string[] = [];
    for (let i = 0; i < 21; i++) ids.push((await store.createTab({ content: `c${i}` })).id);
    for (const id of ids) await store.closeTab(id);
    expect(store.session.closedStack).toHaveLength(20);
    expect(existsSync(join(dir, "buffers", "closed", `${ids[0]}.ts`))).toBe(false);
    expect(existsSync(join(dir, "buffers", "closed", `${ids[20]}.ts`))).toBe(true);
  });

  test("a view state for a closed or unknown tab is a quiet no-op: no change, no write, nothing to log (Seat B cross-seat 3)", async () => {
    const store = await open();
    const b = await store.createTab();
    await store.closeTab(b.id);
    const heard: Session[] = [];
    store.onChange((session) => heard.push(session));
    const before = store.session;
    store.setViewState(b.id, { cursorState: [{ position: { lineNumber: 2, column: 1 } }] });
    store.setViewState("never-existed", { scrollTop: 1 });
    expect(heard).toEqual([]);
    expect(store.session).toBe(before);
  });

  test("while session.json is from a newer JSLab, closed buffers are never deleted by eviction or reopen (FA-m5)", async () => {
    const closed = Array.from({ length: 20 }, (_, i) => `c${i}`);
    await mkdir(join(dir, "buffers", "closed"), { recursive: true });
    for (const id of closed) await writeFile(join(dir, "buffers", "closed", `${id}.ts`), id);
    await writeFile(
      join(dir, "session.json"),
      JSON.stringify({
        version: 99,
        tabOrder: ["a", "b"],
        activeTabId: "a",
        tabs: { a: { id: "a", title: "a" }, b: { id: "b", title: "b" } },
        closedStack: closed.map((id, i) => ({ tab: { id, title: id }, closedAt: 100 - i })),
      }),
    );
    const store = await open();
    expect(store.newerVersion).toBe(99);
    // Closing a 21st tab evicts the oldest entry (c19), which the newer file still lists.
    await store.closeTab("a");
    expect(existsSync(join(dir, "buffers", "closed", "c19.ts"))).toBe(true);
    // Reopening moves the buffer back into buffers/ but leaves the closed copy in place.
    expect((await store.reopenClosed())?.tab.id).toBe("a");
    expect(existsSync(join(dir, "buffers", "closed", "a.ts"))).toBe(true);
  });

  test("reorder accepts only permutations; activate ignores unknown ids; view state persists", async () => {
    const store = await open();
    const b = await store.createTab();
    store.reorderTabs(["t1"]);
    store.reorderTabs(["t1", b.id, "ghost"]);
    expect(store.session.tabOrder).toEqual(["t1", b.id]);
    store.reorderTabs([b.id, "t1"]);
    expect(store.session.tabOrder).toEqual([b.id, "t1"]);
    store.activateTab("ghost");
    expect(store.session.activeTabId).toBe(b.id);
    store.setViewState("t1", { cursorState: [{ position: { lineNumber: 3, column: 1 } }] });
    await store.flush();
    const reopened = await open();
    expect(reopened.session.tabs.t1?.viewState).toEqual({ cursorState: [{ position: { lineNumber: 3, column: 1 } }] });
    expect(reopened.session.tabOrder).toEqual([b.id, "t1"]);
  });

  test("patchTab updates file fields, runtime and partial layout; findTabByPath looks tabs up by file", async () => {
    const store = await open();
    await store.patchTab("t1", {
      filePath: "/w/a.ts",
      lastSavedHash: "5-abc",
      runtime: "bun",
      layout: { outputVisible: false },
    });
    expect(store.session.tabs.t1).toMatchObject({
      filePath: "/w/a.ts",
      lastSavedHash: "5-abc",
      layout: { orientation: "horizontal", editorSize: 55, outputVisible: false },
    });
    expect(store.findTabByPath("/w/a.ts")?.id).toBe("t1");
    expect(store.findTabByPath("/w/b.ts")).toBeNull();
  });

  // Fix round 1 (F5): a partial tiles patch merges field-by-field onto the tab's existing tiles, rather than
  // replacing the whole object and silently resetting every field the patch didn't mention to its schema default.
  test("patchTab merges a partial layout.tiles patch onto the tab's existing tiles instead of replacing it", async () => {
    const store = await open();
    await store.patchTab("t1", { layout: { tiles: { consoleSize: 70 } } });
    await store.patchTab("t1", { layout: { tiles: { webviewVisible: true } } });
    // The second patch names only `webviewVisible`, so `consoleSize` must still be the 70 the first one set --
    // a wholesale replace would have reset it to the schema default of 55.
    expect(store.session.tabs.t1?.layout.tiles).toEqual({ webviewVisible: true, consoleSize: 70 });
  });

  test("setWorkingDirectory updates a known tab, persists it, and returns null for an unknown tab", async () => {
    const store = await open();
    expect(store.setWorkingDirectory("ghost", "/w/api")).toBeNull();
    const tab = store.setWorkingDirectory("t1", "/w/api");
    expect(tab).toMatchObject({ id: "t1", workingDirectory: "/w/api" });
    await store.flush();
    const reopened = await open();
    expect(reopened.session.tabs.t1?.workingDirectory).toBe("/w/api");
  });

  test("change listeners hear every mutation and can unsubscribe", async () => {
    const store = await open();
    const seen: Session[] = [];
    const off = store.onChange((session) => seen.push(session));
    const b = await store.createTab();
    store.activateTab("t1");
    await store.patchTab("t1", { title: "x", titleIsCustom: true });
    off();
    store.activateTab(b.id);
    expect(seen.map((session) => session.activeTabId)).toEqual([b.id, "t1", "t1"]);
  });

  test("buffer writes keep the previous content as .bak, renames carry it, and closing removes it (spec §10.1)", async () => {
    const store = await open();
    store.setBuffer("t1", "first");
    await store.flush();
    store.setBuffer("t1", "second");
    await store.flush();
    expect(await readFile(join(dir, "buffers", "t1.ts"), "utf8")).toBe("second");
    expect(await readFile(join(dir, "buffers", "t1.ts.bak"), "utf8")).toBe("first");
    await store.patchTab("t1", { language: "javascript" });
    expect(existsSync(join(dir, "buffers", "t1.ts.bak"))).toBe(false);
    expect(await readFile(join(dir, "buffers", "t1.js.bak"), "utf8")).toBe("first");
    await store.createTab();
    await store.closeTab("t1");
    expect(existsSync(join(dir, "buffers", "t1.js.bak"))).toBe(false);
  });

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "closeTab rejects and leaves the tab open when its buffer can't be moved to the closed stack",
    async () => {
      const store = await open();
      const b = await store.createTab({ content: "kept" });
      await mkdir(join(dir, "buffers", "closed"), { recursive: true });
      // No write permission on buffers/: the rename can't remove the source entry there, so it fails with
      // EACCES, not ENOENT. (buffers/closed/ itself stays writable, so a naive fallback write would succeed
      // and mask the failure — this is what distinguishes a real move failure from a merely-missing buffer.)
      await chmod(join(dir, "buffers"), 0o500);
      try {
        await expect(store.closeTab(b.id)).rejects.toThrow();
      } finally {
        await chmod(join(dir, "buffers"), 0o700);
      }
      expect(store.session.tabs[b.id]).toBeDefined();
      expect(store.session.tabOrder).toContain(b.id);
      expect(store.session.closedStack).toEqual([]);
      expect(await readFile(join(dir, "buffers", `${b.id}.ts`), "utf8")).toBe("kept");
      store.setBuffer(b.id, "still saves");
      await store.flush();
      expect(await readFile(join(dir, "buffers", `${b.id}.ts`), "utf8")).toBe("still saves");
    },
  );

  test("a genuinely first launch opens the welcome tab, and later launches never do", async () => {
    const firstRun = { title: "Welcome", content: "// hello\n", language: "tsx" as const };
    const store = await SessionStore.open(dir, { delayMs: 10, firstRun });
    stores.push(store);
    const [onlyId] = store.session.tabOrder;
    if (!onlyId) throw new Error("expected one tab");
    expect(store.session.tabs[onlyId]).toMatchObject({
      title: "Welcome",
      titleIsCustom: true,
      language: "tsx",
      // R-M5a-REGRESSION-2: what lets ⌘W tell an untouched welcome tab from a tab the user has made theirs.
      pristine: true,
    });
    expect(await store.readBuffer(onlyId)).toBe("// hello\n");
    await store.flush();

    // A write of the very same bytes is not an edit. The UI flushes buffers on its own schedule, so trusting
    // "a write happened" rather than comparing content would retire the flag without the user touching anything.
    store.setBuffer(onlyId, "// hello\n");
    expect(store.session.tabs[onlyId]?.pristine).toBe(true);

    // Second launch: a real session.json exists, so nothing is replaced. It is the user's own edit that has to
    // survive -- re-asserting the welcome text here would pass even if the welcome had been written over their
    // work, because the sample and the stored content would be byte-identical.
    store.setBuffer(onlyId, "// the user's own work\n");
    expect(store.session.tabs[onlyId]?.pristine).toBe(false);
    await store.flush();
    const second = await SessionStore.open(dir, { delayMs: 10, firstRun });
    stores.push(second);
    expect(second.session.tabOrder).toEqual(store.session.tabOrder);
    expect(await second.readBuffer(onlyId)).toBe("// the user's own work\n");
    expect(second.session.tabs[onlyId]).toMatchObject({ title: "Welcome", titleIsCustom: true, language: "tsx" });
    // The edit outlives the launch: a returning user's ⌘W must not close the window on work they can see.
    expect(second.session.tabs[onlyId]?.pristine).toBe(false);
  });

  test("a corrupt session.json is not treated as a first run", async () => {
    await writeFile(join(dir, "session.json"), "{ not json");
    const store = await SessionStore.open(dir, {
      delayMs: 10,
      newTab: () => createTab({ id: "t1" }),
      firstRun: { title: "Welcome", content: "// hello\n", language: "tsx" },
    });
    stores.push(store);
    const [onlyId] = store.session.tabOrder;
    if (!onlyId) throw new Error("expected one tab");
    // Recovered to defaults, not a first launch: an empty scratch tab, no welcome content.
    expect(store.session.tabs[onlyId]?.titleIsCustom).toBe(false);
    expect(await store.readBuffer(onlyId)).toBe("");
  });

  // R-M5a-5 names three cases and the two above cover only two of them. This is the dangerous one: session.json is
  // genuinely gone, so `primary` really is "missing", and only the `recovered === "none"` half of the condition
  // stands between a user whose session came back from its backup and having their work replaced by the sample.
  test("a session recovered from session.json.bak is not treated as a first run", async () => {
    await writeFile(
      join(dir, "session.json.bak"),
      JSON.stringify({
        tabOrder: ["kept"],
        activeTabId: "kept",
        tabs: { kept: { id: "kept", title: "My work" } },
        closedStack: [],
      }),
    );
    const store = await SessionStore.open(dir, {
      delayMs: 10,
      newTab: () => createTab({ id: "t1" }),
      firstRun: { title: "Welcome", content: "// hello\n", language: "tsx" },
    });
    stores.push(store);
    expect(store.recovered).toBe("backup");
    expect(store.session.tabOrder).toEqual(["kept"]);
    expect(store.session.tabs.kept).toMatchObject({ title: "My work", titleIsCustom: false, language: "typescript" });
    expect(await store.readBuffer("kept")).toBe("");
  });
});
