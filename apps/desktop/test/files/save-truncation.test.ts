import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bufferFileName, contentHash, createTab, type TabState } from "@jslab/shared";
import { FileService, nodeFileSystem } from "../../src/main/files/file-service";
import { createFileHandlers, type FileHandlerDeps } from "../../src/main/rpc/file-handlers";
import { SessionStore } from "../../src/main/services/session-store";
import { strings } from "../../src/main/strings";

/**
 * B1. The degrading bootstrap (F1) is right to keep the app openable when one tab's buffer file can't be read --
 * but the guard it relies on covers only the *internal* buffer file under `<dataDir>/buffers/`. `setBuffer`
 * refuses an unreadable tab; nothing guarded the tab's `filePath`, the user's own source file, which `file.save`
 * writes through an entirely separate path.
 *
 * The chain: `readBuffer` throws, so bootstrap omits the tab; the UI turns that absence into `""`; `isDirty` is
 * then true against the real file's `lastSavedHash`, so ⌘S (or the Save button on ⌘W's "Save changes?" prompt)
 * sends `file.save(tabId, "")` and the real file is truncated to zero bytes. `FileService.write` passes no
 * `{ backup: true }`, so there is no `.bak` either.
 *
 * These tests are the last line: they drive the REAL `SessionStore`, the REAL `FileService` and the REAL file
 * system, and assert on the bytes actually left on disk. They hold whatever any UI sends, which is the point --
 * the UI-side guards (store/file-flows) are defence in front of this, not instead of it.
 */

const SOURCE = "export const answer = 42;\n";

let dir = "";
let stores: SessionStore[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jslab-truncation-"));
  stores = [];
});
afterEach(async () => {
  await Promise.all(stores.map((store) => store.flush()));
  await rm(dir, { recursive: true, force: true });
});

/** A session store over a real data dir, with one file-backed tab whose real source file holds SOURCE. */
async function fileBackedTab(): Promise<{ store: SessionStore; tab: TabState; source: string }> {
  const source = join(dir, "app.ts");
  await writeFile(source, SOURCE);
  const store = await SessionStore.open(dir, { newTab: () => createTab({ id: "t1" }), delayMs: 10 });
  stores.push(store);
  const tab = await store.createTab({
    filePath: source,
    language: "typescript",
    lastSavedHash: contentHash(SOURCE),
    content: SOURCE,
  });
  return { store, tab, source };
}

/**
 * Makes the tab's buffer file unreadable the way the F1 fix targets: a directory where a file is expected, so
 * `readFile` fails with EISDIR rather than ENOENT. (EISDIR needs no chmod, so this also runs as root, unlike the
 * EACCES technique `session-tabs.test.ts` uses for `closeTab`.)
 */
async function makeBufferUnreadable(store: SessionStore, tab: TabState): Promise<void> {
  const bufferPath = join(dir, "buffers", bufferFileName(tab));
  await rm(bufferPath, { force: true });
  await mkdir(bufferPath, { recursive: true });
  // Exactly what bootstrap's per-tab read does, and what puts the tab in the store's unreadable set.
  await expect(store.readBuffer(tab.id)).rejects.toThrow(/Couldn't read the buffer for tab/);
}

function handlersFor(store: SessionStore, options: { saveTo?: string } = {}) {
  const sent: { name: string; payload: unknown }[] = [];
  const record = (name: string) => (payload: unknown) => sent.push({ name, payload });
  const deps = {
    files: new FileService(nodeFileSystem),
    session: store,
    documentsDir: dir,
    openDialog: async () => [],
    // A path the user actively picked, so the dialog result is NOT the untouched default: that reaches
    // `completeSaveAs` and really writes, instead of stopping at a confirmation prompt (m-6/M0-S6).
    saveDialog: async () => options.saveTo ?? null,
    revealInFinder: () => {},
    clipboard: () => {},
    send: {
      opened: record("file.opened"),
      saved: record("file.saved"),
      saveAsConfirm: record("file.saveAsConfirm"),
      saveCancelled: record("file.saveCancelled"),
      saveFailed: record("file.saveFailed"),
    },
    log: () => {},
  } satisfies FileHandlerDeps;
  return { sent, handlers: createFileHandlers(deps) };
}

describe("a tab whose buffer couldn't be read never writes over its own file (B1)", () => {
  test("file.save refuses instead of truncating the real file to zero bytes", async () => {
    const { store, tab, source } = await fileBackedTab();
    await makeBufferUnreadable(store, tab);

    // Precisely what the UI sent before the fix: the empty string it invented for the absent buffer.
    const result = await handlersFor(store).handlers.requests["file.save"]({ tabId: tab.id, content: "" });

    // The bytes on disk are what actually matters. Before the fix this file was 0 bytes.
    expect(await readFile(source, "utf8")).toBe(SOURCE);
    expect(result).toEqual({ ok: false, error: strings.files.bufferUnreadable });
    // And the tab's saved hash still describes the real file, so nothing downstream thinks "" was persisted.
    expect(store.session.tabs[tab.id]?.lastSavedHash).toBe(contentHash(SOURCE));
  });

  /**
   * Not a theoretical extra: `FileService.write` passes no `{ backup: true }` (unlike the buffer writer at
   * `session-store.ts`), so if the truncating write ever happens there is no `.bak` to recover from. This pins
   * that the refusal above is the ONLY thing standing between the user and losing the file.
   */
  test("the refusal is the only protection: a save of this tab leaves no .bak behind either", async () => {
    const { store, tab, source } = await fileBackedTab();
    await makeBufferUnreadable(store, tab);

    await handlersFor(store).handlers.requests["file.save"]({ tabId: tab.id, content: "" });

    expect(existsSync(`${source}.bak`)).toBe(false);
    expect(await readFile(source, "utf8")).toBe(SOURCE);
  });

  /** Save As routes through a different function (`completeSaveAs`); it must not write the invented text either. */
  test("Save As refuses too, rather than writing an invented empty file to the chosen path", async () => {
    const { store, tab } = await fileBackedTab();
    await makeBufferUnreadable(store, tab);
    const chosen = join(dir, "copy.ts");
    const { sent, handlers } = handlersFor(store, { saveTo: chosen });

    handlers.messages["file.saveAsDialog"]({ tabId: tab.id, content: "" });
    for (let i = 0; i < 200 && sent.length === 0; i++) await Bun.sleep(2);

    expect(sent).toEqual([
      { name: "file.saveFailed", payload: { tabId: tab.id, error: strings.files.bufferUnreadable } },
    ]);
    expect(existsSync(chosen)).toBe(false);
  });

  /**
   * The guard is specifically about "JSLab does not know this tab's text", not "this tab is broken forever": a
   * tab whose buffer reads fine still saves normally, and a tab whose buffer becomes readable again recovers
   * (`readBuffer` clears the unreadable entry on a successful read).
   */
  test("a readable tab still saves, and a tab that recovers can save again", async () => {
    const { store, tab, source } = await fileBackedTab();
    const { handlers } = handlersFor(store);

    expect(await handlers.requests["file.save"]({ tabId: tab.id, content: "const a = 1\n" })).toMatchObject({
      ok: true,
    });
    expect(await readFile(source, "utf8")).toBe("const a = 1\n");

    await makeBufferUnreadable(store, tab);
    expect(await handlers.requests["file.save"]({ tabId: tab.id, content: "" })).toEqual({
      ok: false,
      error: strings.files.bufferUnreadable,
    });

    // Repair the buffer file and read it back: the tab leaves the unreadable set and saves normally again.
    const bufferPath = join(dir, "buffers", bufferFileName(tab));
    await rm(bufferPath, { recursive: true, force: true });
    await writeFile(bufferPath, "const b = 2\n");
    expect(await store.readBuffer(tab.id)).toBe("const b = 2\n");
    expect(await handlers.requests["file.save"]({ tabId: tab.id, content: "const b = 2\n" })).toMatchObject({
      ok: true,
    });
    expect(await readFile(source, "utf8")).toBe("const b = 2\n");
  });
});
