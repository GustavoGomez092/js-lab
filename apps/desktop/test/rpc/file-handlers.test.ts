import { describe, expect, mock, test } from "bun:test";
import type { FileOpened } from "@jslab/rpc-schema";
import { contentHash, createTab, type TabState } from "@jslab/shared";
import { createFileHandlers, type FileHandlerDeps } from "../../src/main/rpc/file-handlers";

// Tokens are uuids at the RPC boundary (fileConfirmLargeSchema, fileConfirmSaveAsSchema).
const LARGE_TOKEN = "11111111-1111-4111-8111-111111111111";
const SAVE_TOKEN = "22222222-2222-4222-8222-222222222222";

function setup(options: { saveResult?: string | null | Error; openPaths?: string[] } = {}) {
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
        return { tabs, lastDirectory: null } as never;
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
    documentsDir: "/Docs",
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
});
