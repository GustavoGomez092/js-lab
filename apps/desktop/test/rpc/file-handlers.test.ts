import { describe, expect, mock, test } from "bun:test";
import { mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileOpened } from "@jslab/rpc-schema";
import { contentHash, createTab, type TabState } from "@jslab/shared";
import { createFileHandlers, type FileHandlerDeps } from "../../src/main/rpc/file-handlers";

// Tokens are uuids at the RPC boundary (fileConfirmLargeSchema, fileConfirmSaveAsSchema).
const LARGE_TOKEN = "11111111-1111-4111-8111-111111111111";
const SAVE_TOKEN = "22222222-2222-4222-8222-222222222222";

function setup(
  options: {
    saveResult?: string | null | Error;
    openPaths?: string[];
    documentsDir?: string;
    lastDirectory?: string | null;
  } = {},
) {
  const tabs: Record<string, TabState> = {
    scratch: createTab({ id: "scratch", language: "tsx" }),
    saved: createTab({ id: "saved", filePath: "/w/a.ts", lastSavedHash: "old" }),
  };
  const sent: { name: string; payload: unknown }[] = [];
  const record = (name: string) => (payload: unknown) => sent.push({ name, payload });
  const deps = {
    files: {
      prepareOpen: mock(async (paths: string[]) => ({
        ready: paths.filter((p) => !p.includes("big")).map((path) => ({ path, content: `// ${path}` })),
        large: paths.filter((p) => p.includes("big")).map((path) => ({ token: LARGE_TOKEN, path, size: 6_000_000 })),
        errors: [],
      })),
      confirmLarge: mock(async () => ({ ready: [{ path: "/w/big.js", content: "big" }], errors: [] })),
      write: mock(async (_path: string, content: string) => contentHash(content)),
      issueSaveAsToken: mock(() => SAVE_TOKEN),
      takeSaveAsToken: mock((token: string) =>
        token === SAVE_TOKEN ? { tabId: "scratch", path: "/Docs/Untitled.tsx", content: "<a/>" } : null,
      ),
    },
    session: {
      get session() {
        return { tabs, lastDirectory: options.lastDirectory ?? null } as never;
      },
      createTab: mock(
        async (o: { filePath?: string | null; language?: TabState["language"]; lastSavedHash?: string | null }) =>
          createTab({
            id: `new-${o.filePath}`,
            filePath: o.filePath ?? null,
            language: o.language,
            lastSavedHash: o.lastSavedHash ?? null,
          }),
      ),
      patchTab: mock(async (tabId: string, patch: Partial<TabState>) => {
        tabs[tabId] = { ...(tabs[tabId] as TabState), ...patch };
      }),
      findTabByPath: mock((path: string) => Object.values(tabs).find((tab) => tab.filePath === path) ?? null),
      setLastDirectory: mock(() => {}),
    },
    openDialog: mock(async () => options.openPaths ?? []),
    saveDialog: mock(async () => {
      if (options.saveResult instanceof Error) throw options.saveResult;
      return options.saveResult === undefined ? "/Other/picked.tsx" : options.saveResult;
    }),
    documentsDir: options.documentsDir ?? "/Docs",
    revealInFinder: mock((_path: string) => {}),
    clipboard: mock((_text: string) => {}),
    send: {
      opened: record("file.opened"),
      saved: record("file.saved"),
      saveAsConfirm: record("file.saveAsConfirm"),
      saveCancelled: record("file.saveCancelled"),
      saveFailed: record("file.saveFailed"),
    },
    log: mock(() => {}),
  } satisfies FileHandlerDeps;
  return { deps, sent, tabs, handlers: createFileHandlers(deps) };
}

const flush = () => Bun.sleep(5);

describe("file handlers", () => {
  test("the open dialog creates tabs by extension, focuses open files and forwards large files", async () => {
    const { handlers, sent, deps } = setup({ openPaths: ["/w/b.jsx", "/w/a.ts", "/w/big.js"] });
    handlers.messages["file.openDialog"]({});
    await flush();
    expect(deps.openDialog).toHaveBeenCalledWith({ startingFolder: "/Docs" });
    const opened = sent[0]?.payload as FileOpened;
    expect(opened.tabs.map(({ tab }) => [tab.filePath, tab.language, tab.lastSavedHash])).toEqual([
      ["/w/b.jsx", "jsx", contentHash("// /w/b.jsx")],
    ]);
    expect(opened.focusTabId).toBe("saved");
    expect(opened.large).toEqual([{ token: LARGE_TOKEN, path: "/w/big.js", size: 6_000_000 }]);
    expect(deps.session.setLastDirectory).toHaveBeenCalledWith("/w");
  });

  test("confirmed large files open like any other file", async () => {
    const { handlers, sent } = setup();
    handlers.messages["file.confirmLarge"]({ tokens: [LARGE_TOKEN] });
    await flush();
    const opened = sent[0]?.payload as FileOpened;
    expect(opened.tabs[0]?.tab.filePath).toBe("/w/big.js");
  });

  test("file.save writes the tab's own path, and scratch tabs need Save As", async () => {
    const { handlers, deps, tabs } = setup();
    expect(await handlers.requests["file.save"]({ tabId: "saved", content: "v2" })).toEqual({
      ok: true,
      tab: tabs.saved as TabState,
    });
    expect(deps.files.write).toHaveBeenCalledWith("/w/a.ts", "v2");
    expect(tabs.saved?.lastSavedHash).toBe(contentHash("v2"));
    expect(await handlers.requests["file.save"]({ tabId: "scratch", content: "x" })).toEqual({ needsSaveAs: true });
    expect(await handlers.requests["file.save"]({ tabId: "ghost", content: "x" })).toEqual({
      ok: false,
      error: "That tab is no longer open.",
    });
  });

  test("Save As writes a chosen path, but asks before trusting the default path", async () => {
    const picked = setup();
    picked.handlers.messages["file.saveAsDialog"]({ tabId: "scratch", content: "<a/>" });
    await flush();
    expect(picked.deps.saveDialog).toHaveBeenCalledWith({ defaultName: "<a->.tsx", defaultDir: "/Docs" });
    expect(picked.sent.map((m) => m.name)).toEqual(["file.saved"]);
    expect(picked.tabs.scratch).toMatchObject({ filePath: "/Other/picked.tsx", lastSavedHash: contentHash("<a/>") });

    const defaulted = setup({ saveResult: "/Docs/<a-" + ">.tsx" });
    defaulted.handlers.messages["file.saveAsDialog"]({ tabId: "scratch", content: "<a/>" });
    await flush();
    expect(defaulted.deps.files.write).not.toHaveBeenCalled();
    expect(defaulted.sent).toEqual([
      { name: "file.saveAsConfirm", payload: { token: SAVE_TOKEN, tabId: "scratch", path: "/Docs/<a->.tsx" } },
    ]);
    // R-M2-T18-1: a confirmation whose token expired (5-minute TTL) answers the tab's pending Save As.
    defaulted.deps.files.takeSaveAsToken.mockImplementation(() => null);
    defaulted.handlers.messages["file.confirmSaveAs"]({ token: SAVE_TOKEN, confirmed: true });
    await flush();
    expect(defaulted.deps.files.write).not.toHaveBeenCalled();
    expect(defaulted.sent.at(-1)).toEqual({
      name: "file.saveFailed",
      payload: { tabId: "scratch", error: "That save request expired. Save again." },
    });

    const cancelled = setup({ saveResult: null });
    cancelled.handlers.messages["file.saveAsDialog"]({ tabId: "scratch", content: "" });
    const failed = setup({ saveResult: new Error("osascript exited with 1") });
    failed.handlers.messages["file.saveAsDialog"]({ tabId: "scratch", content: "" });
    await flush();
    expect(cancelled.sent).toEqual([{ name: "file.saveCancelled", payload: { tabId: "scratch" } }]);
    expect(failed.sent).toEqual([
      { name: "file.saveFailed", payload: { tabId: "scratch", error: "osascript exited with 1" } },
    ]);
  });

  test("save-as confirmations, reveal and copy path act only on known tokens and saved tabs", async () => {
    const { handlers, sent, deps } = setup();
    handlers.messages["file.confirmSaveAs"]({ token: SAVE_TOKEN, confirmed: true });
    await flush();
    expect(deps.files.write).toHaveBeenCalledWith("/Docs/Untitled.tsx", "<a/>");
    expect(sent.at(-1)?.name).toBe("file.saved");
    // Not a uuid → rejected at validation and logged.
    handlers.messages["file.confirmSaveAs"]({ token: "unknown", confirmed: true });
    handlers.messages["tab.revealInFinder"]({ tabId: "saved" });
    handlers.messages["tab.copyPath"]({ tabId: "saved" });
    handlers.messages["tab.copyPath"]({ tabId: "ghost" });
    // A string instead of an array → rejected at validation and logged.
    handlers.messages["file.confirmLarge"]({ tokens: LARGE_TOKEN });
    await flush();
    expect(deps.files.write).toHaveBeenCalledTimes(1);
    expect(deps.revealInFinder).toHaveBeenCalledWith("/w/a.ts");
    expect(deps.clipboard.mock.calls).toEqual([["/w/a.ts"]]);
    expect(deps.log).toHaveBeenCalledTimes(2);
  });

  // Test 3 (m-2): a closed tab must never be written to, whether it was already gone when the dialog opened, or
  // closed while the (async) dialog was still pending.
  test("Save As fails without writing when the tab is gone", async () => {
    const missing = setup();
    missing.handlers.messages["file.saveAsDialog"]({ tabId: "ghost", content: "x" });
    await flush();
    expect(missing.sent).toEqual([
      { name: "file.saveFailed", payload: { tabId: "ghost", error: "That tab is no longer open." } },
    ]);
    expect(missing.deps.files.write).not.toHaveBeenCalled();

    const closedMidDialog = setup();
    closedMidDialog.handlers.messages["file.saveAsDialog"]({ tabId: "scratch", content: "<a/>" });
    delete closedMidDialog.tabs.scratch;
    await flush();
    expect(closedMidDialog.sent).toEqual([
      { name: "file.saveFailed", payload: { tabId: "scratch", error: "That tab is no longer open." } },
    ]);
    expect(closedMidDialog.deps.files.write).not.toHaveBeenCalled();
  });

  // Test 4 (m-3): the default-path comparison normalizes both sides to NFC and resolves the default folder's
  // real path first, so a dialog result under the folder's realpath (e.g. /private/var vs /var on macOS) in NFD
  // form still counts as the untouched default and triggers confirmation instead of a silent write.
  test("Save As treats an NFD-normalized dialog result as the untouched default path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jslab-nfd-"));
    try {
      const realDir = await realpath(dir);
      const composedName = "café.ts";
      const nfdPath = join(realDir, composedName).normalize("NFD");
      const s = setup({ documentsDir: dir, saveResult: nfdPath });
      s.tabs.accent = createTab({ id: "accent", title: "café", titleIsCustom: true, language: "typescript" });
      s.handlers.messages["file.saveAsDialog"]({ tabId: "accent", content: "" });
      await flush();
      expect(s.deps.files.write).not.toHaveBeenCalled();
      expect(s.sent).toEqual([
        { name: "file.saveAsConfirm", payload: { token: SAVE_TOKEN, tabId: "accent", path: nfdPath } },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // R-M2-T18-1: the dialog result is resolved like the default folder, so the untouched default path reached
  // through a symlinked folder (on macOS /var -> /private/var) still asks for confirmation instead of writing.
  test("Save As treats the default path spelled through a symlinked folder as the untouched default", async () => {
    const realDir = await realpath(await mkdtemp(join(tmpdir(), "jslab-real-")));
    const linkParent = await mkdtemp(join(tmpdir(), "jslab-link-"));
    try {
      const linkDir = join(linkParent, "docs");
      await symlink(realDir, linkDir);
      const chosen = join(linkDir, "Untitled.tsx");
      const s = setup({ documentsDir: linkDir, saveResult: chosen });
      s.handlers.messages["file.saveAsDialog"]({ tabId: "scratch", content: "" });
      await flush();
      expect(s.deps.saveDialog).toHaveBeenCalledWith({ defaultName: "Untitled.tsx", defaultDir: linkDir });
      expect(s.deps.files.write).not.toHaveBeenCalled();
      expect(s.sent).toEqual([
        { name: "file.saveAsConfirm", payload: { token: SAVE_TOKEN, tabId: "scratch", path: chosen } },
      ]);
    } finally {
      await rm(linkParent, { recursive: true, force: true });
      await rm(realDir, { recursive: true, force: true });
    }
  });

  // Test 7 (m-6): Save As must not silently overwrite a path a different tab already has open.
  test("Save As refuses to overwrite a path another tab already has open", async () => {
    const { handlers, sent, deps } = setup({ saveResult: "/w/a.ts" });
    handlers.messages["file.saveAsDialog"]({ tabId: "scratch", content: "<a/>" });
    await flush();
    expect(deps.files.write).not.toHaveBeenCalled();
    expect(sent).toEqual([
      { name: "file.saveFailed", payload: { tabId: "scratch", error: "a.ts is already open in another tab." } },
    ]);
  });

  // Test 8 (m-7 a, b): the default name reuses the tab's own file name verbatim when it has one; after a
  // successful save, the language is re-derived only for source extensions, never for json/txt.
  test("Save As uses the file's own name as default and updates language only for source extensions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jslab-saveas-name-"));
    try {
      const ts = setup({ documentsDir: dir, saveResult: join(dir, "renamed.tsx") });
      ts.tabs.tsTab = createTab({
        id: "tsTab",
        filePath: join(dir, "original.ts"),
        language: "typescript",
        lastSavedHash: "h",
      });
      ts.handlers.messages["file.saveAsDialog"]({ tabId: "tsTab", content: "x" });
      await flush();
      expect(ts.deps.saveDialog).toHaveBeenCalledWith({ defaultName: "original.ts", defaultDir: dir });
      expect(ts.tabs.tsTab).toMatchObject({ filePath: join(dir, "renamed.tsx"), language: "tsx" });

      const json = setup({ documentsDir: dir, saveResult: join(dir, "data.json") });
      json.tabs.jsonTab = createTab({
        id: "jsonTab",
        filePath: join(dir, "data.json"),
        language: "typescript",
        lastSavedHash: "h",
      });
      json.handlers.messages["file.saveAsDialog"]({ tabId: "jsonTab", content: "{}" });
      await flush();
      expect(json.deps.saveDialog).toHaveBeenCalledWith({ defaultName: "data.json", defaultDir: dir });
      expect(json.tabs.jsonTab).toMatchObject({ filePath: join(dir, "data.json"), language: "typescript" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // Test 9 (m-7 c): the default folder falls back through candidates that no longer exist on disk, ending at
  // Documents.
  test("Save As falls back through missing default folders to Documents", async () => {
    const docs = await mkdtemp(join(tmpdir(), "jslab-docs-"));
    const lastDir = await mkdtemp(join(tmpdir(), "jslab-last-"));
    try {
      const missingLast = join(lastDir, "gone");
      const noFilePath = setup({ documentsDir: docs, lastDirectory: missingLast });
      noFilePath.handlers.messages["file.saveAsDialog"]({ tabId: "scratch", content: "" });
      await flush();
      expect(noFilePath.deps.saveDialog).toHaveBeenCalledWith({ defaultName: "Untitled.tsx", defaultDir: docs });

      const missingOwnFolder = setup({ documentsDir: docs, lastDirectory: lastDir });
      missingOwnFolder.tabs.ghost = createTab({
        id: "ghost",
        filePath: join(docs, "missing-subdir", "a.ts"),
        language: "typescript",
      });
      missingOwnFolder.handlers.messages["file.saveAsDialog"]({ tabId: "ghost", content: "" });
      await flush();
      expect(missingOwnFolder.deps.saveDialog).toHaveBeenCalledWith({ defaultName: "a.ts", defaultDir: lastDir });
    } finally {
      await rm(docs, { recursive: true, force: true });
      await rm(lastDir, { recursive: true, force: true });
    }
  });

  // Test 10 (m-9): a declined Save As confirmation must cancel, not write.
  test("confirmSaveAs cancellation writes nothing", async () => {
    const { handlers, sent, deps } = setup();
    handlers.messages["file.confirmSaveAs"]({ token: SAVE_TOKEN, confirmed: false });
    await flush();
    expect(deps.files.write).not.toHaveBeenCalled();
    expect(sent).toEqual([{ name: "file.saveCancelled", payload: { tabId: "scratch" } }]);
  });
});
