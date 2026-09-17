import { describe, expect, mock, test } from "bun:test";
import type { FileOpened } from "@jslab/rpc-schema";
import { createTab, type TabState } from "@jslab/shared";
import { createOpenService, type OpenServiceDeps } from "../../src/main/cli/open-service";
import type { TabPatch } from "../../src/main/services/session-store";

function setup(files: Record<string, string> = {}, open: Record<string, string> = {}) {
  const announced: FileOpened[] = [];
  const presented: { run: boolean }[] = [];
  const activated: string[] = [];
  const patched: { tabId: string; patch: TabPatch }[] = [];
  const updates: { tabId: string; tab: TabState }[] = [];
  let next = 0;
  const deps = {
    session: {
      createTab: mock(async (options: Record<string, unknown>) => createTab({ id: `t${++next}`, ...options })),
      // `SessionStore.findTabByPath` returns `TabState | null`, so the miss case is null, not undefined.
      findTabByPath: mock((path: string) => (open[path] ? createTab({ id: open[path], filePath: path }) : null)),
      activateTab: mock((tabId: string) => {
        activated.push(tabId);
      }),
      patchTab: mock(async (tabId: string, patch: TabPatch) => {
        patched.push({ tabId, patch });
      }),
    },
    readBoundedFile: mock(async (path: string) => {
      const content = files[path];
      if (content === undefined) throw new Error("ENOENT");
      return content;
    }),
    defaults: () => ({ language: "typescript" as const, runtime: "bun" as const }),
    announce: (payload: FileOpened) => announced.push(payload),
    updated: (payload: { tabId: string; tab: TabState }) => updates.push(payload),
    present: (options: { run: boolean }) => presented.push(options),
    log: mock(() => {}),
  } satisfies OpenServiceDeps;
  return { deps, announced, presented, activated, patched, updates, open: createOpenService(deps) };
}

describe("the CLI open service", () => {
  test("opens each file in a tab, with the language from its extension", async () => {
    const { deps, announced, open } = setup({ "/w/a.ts": "const a = 1", "/w/b.jsx": "<b/>" });
    expect(await open({ files: ["/w/a.ts", "/w/b.jsx"] })).toEqual({ tabIds: ["t1", "t2"] });
    expect(deps.session.createTab.mock.calls.map(([options]) => options)).toEqual([
      {
        filePath: "/w/a.ts",
        language: "typescript",
        content: "const a = 1",
        lastSavedHash: expect.any(String),
        workingDirectory: null,
      },
      {
        filePath: "/w/b.jsx",
        language: "jsx",
        content: "<b/>",
        lastSavedHash: expect.any(String),
        workingDirectory: null,
      },
    ]);
    expect(announced).toHaveLength(1);
    expect(announced[0]?.tabs.map((entry) => entry.tab.id)).toEqual(["t1", "t2"]);
    expect(announced[0]).toMatchObject({ focusTabId: null, large: [], errors: [] });
  });

  test("focuses a file that is already open instead of opening it twice (§10.2)", async () => {
    const { deps, announced, open } = setup({ "/w/a.ts": "x" }, { "/w/a.ts": "already" });
    expect(await open({ files: ["/w/a.ts"] })).toEqual({ tabIds: ["already"] });
    expect(deps.session.createTab).not.toHaveBeenCalled();
    expect(announced[0]?.focusTabId).toBe("already");
  });

  test("stdin code becomes one tab, taking the language and runtime from settings unless overridden", async () => {
    const { deps, open } = setup();
    expect(await open({ code: "1 + 1" })).toEqual({ tabIds: ["t1"] });
    expect(deps.session.createTab).toHaveBeenCalledWith({
      language: "typescript",
      runtime: "bun",
      content: "1 + 1",
      workingDirectory: null,
    });
  });

  test("--runtime, --lang, --cwd and --title reach the created tab, for every runtime", async () => {
    for (const runtime of ["bun", "browser", "browser-node"] as const) {
      const { deps, open } = setup();
      await open({ code: "1", runtime, lang: "jsx", cwd: "/w/project", title: "scratch" });
      expect(deps.session.createTab).toHaveBeenCalledWith({
        language: "jsx",
        runtime,
        content: "1",
        workingDirectory: "/w/project",
        title: "scratch",
        titleIsCustom: true,
      });
    }
  });

  test("--lang overrides the extension for a file, and --cwd applies to it too", async () => {
    const { deps, open } = setup({ "/w/a.txt": "x" });
    await open({ files: ["/w/a.txt"], lang: "javascript", cwd: "/w/project" });
    expect(deps.session.createTab).toHaveBeenCalledWith({
      filePath: "/w/a.txt",
      language: "javascript",
      content: "x",
      lastSavedHash: expect.any(String),
      workingDirectory: "/w/project",
    });
  });

  test("an unreadable file is reported but never stops the others", async () => {
    const { announced, open } = setup({ "/w/a.ts": "x" });
    expect(await open({ files: ["/w/missing.ts", "/w/a.ts"] })).toEqual({ tabIds: ["t1"] });
    expect(announced[0]?.errors).toEqual(["/w/missing.ts couldn't be read."]);
  });

  test("a request whose every file failed becomes an error reply, not a silent success", async () => {
    const { open } = setup();
    await expect(open({ files: ["/w/missing.ts"] })).rejects.toThrow("/w/missing.ts couldn't be read.");
  });

  test("an already-open file becomes the ACTIVE tab, so --run runs the file that was named", async () => {
    // Main's `activeTabId` only moves inside `createTab`, and this request creates nothing. Without an explicit
    // activation a closed-window `jslab --run a.ts` runs whatever tab was active instead of a.ts.
    const { deps, activated, open } = setup({ "/w/a.ts": "x" }, { "/w/a.ts": "already" });
    await open({ files: ["/w/a.ts"], run: true });
    expect(deps.session.activateTab).toHaveBeenCalledWith("already");
    expect(activated).toEqual(["already"]);
  });

  test("a request that only creates tabs leaves createTab's own activation alone", async () => {
    const { deps, activated, open } = setup({ "/w/a.ts": "x" });
    await open({ files: ["/w/a.ts"], run: true });
    expect(activated).toEqual([]);
    expect(deps.session.activateTab).not.toHaveBeenCalled();
  });

  test("an already-open file wins over a newly created one, matching handleOpened's precedence", async () => {
    // `handleOpened` activates the last created tab and then `focusTabId`, so `focusTabId` is where the UI ends up
    // (file-flows.ts:142-143). Main must agree, or a closed-window run picks the other tab.
    const { activated, open } = setup({ "/w/a.ts": "x", "/w/new.ts": "y" }, { "/w/a.ts": "already" });
    await open({ files: ["/w/a.ts", "/w/new.ts"], run: true });
    expect(activated).toEqual(["already"]);
  });

  test("--title renames an already-open tab instead of being silently dropped (R-M5c-TITLE-1)", async () => {
    const { deps, patched, open } = setup({ "/w/a.ts": "x" }, { "/w/a.ts": "already" });
    expect(await open({ files: ["/w/a.ts"], title: "renamed" })).toEqual({ tabIds: ["already"] });
    expect(patched).toEqual([{ tabId: "already", patch: { title: "renamed", titleIsCustom: true } }]);
    expect(deps.session.createTab).not.toHaveBeenCalled();
  });

  test("without --title an already-open tab's title is left alone", async () => {
    const { deps, patched, updates, open } = setup({ "/w/a.ts": "x" }, { "/w/a.ts": "already" });
    await open({ files: ["/w/a.ts"] });
    expect(patched).toEqual([]);
    expect(updates).toEqual([]);
    expect(deps.session.patchTab).not.toHaveBeenCalled();
  });

  test("the rename of an already-open tab is PUSHED to the UI, or only Main knows it (M5c F3)", async () => {
    // `file.opened` carries no entry for an already-open tab, so this push is the UI's ONLY notice of the rename.
    // Without it the tab bar keeps the old title, and the UI's own `tab.patch` used to push that stale title back
    // over the rename on the next unrelated edit -- Main silently reverted.
    const { updates, open } = setup({ "/w/a.ts": "x" }, { "/w/a.ts": "already" });
    await open({ files: ["/w/a.ts"], title: "renamed" });
    expect(updates).toEqual([
      { tabId: "already", tab: expect.objectContaining({ id: "already", title: "renamed", titleIsCustom: true }) },
    ]);
  });

  test("code runs only when run is passed (§16.3)", async () => {
    const quiet = setup({ "/w/a.ts": "x" });
    await quiet.open({ files: ["/w/a.ts"] });
    expect(quiet.presented).toEqual([{ run: false }]);

    const loud = setup({ "/w/a.ts": "x" });
    await loud.open({ files: ["/w/a.ts"], run: true });
    expect(loud.presented).toEqual([{ run: true }]);
  });
});
