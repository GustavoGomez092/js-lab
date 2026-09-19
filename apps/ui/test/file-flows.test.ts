import { describe, expect, mock, test } from "bun:test";
import { contentHash, createTab, defaultSession, defaultSettings, mergeSettings, type TabState } from "@jslab/shared";
import { act, fireEvent, render } from "@testing-library/react";
import { createElement } from "react";
import { type EditorHandle, setEditorHandle } from "../src/editor/editor-handle";
import { createFileFlows, formatSize } from "../src/files/file-flows";
import { ConfirmDialog } from "../src/shell/ConfirmDialog";
import { createDialogs } from "../src/shell/dialogs";
import { createAppStore } from "../src/state/store";
import { strings } from "../src/strings";
import { createTabActions } from "../src/tabs/tab-actions";
import { createFakeApi } from "./fake-api";

/**
 * `lone` builds the single-tab workspace TF-21 is about: no second tab, and the scratch tab's fields and content
 * under the test's control -- R-M5a-REGRESSION-2 needs a tab that is untouched but NOT empty.
 */
function setup(settings = defaultSettings(), lone?: { tab: TabState; content: string }) {
  const store = createAppStore();
  const scratch = lone?.tab ?? createTab({ id: "scratch" });
  store.getState().hydrate({
    settings,
    session: defaultSession(() => scratch),
    buffers: { [scratch.id]: lone?.content ?? "1 + 1" },
    safeMode: { active: false, reason: null },
    versions: { app: "0", bun: "1.4.0" },
  });
  if (!lone)
    store
      .getState()
      .openTab(createTab({ id: "saved", filePath: "/w/a.ts", lastSavedHash: contentHash("v1") }), "v1", false);
  const { api } = createFakeApi();
  const dialogs = createDialogs(store);
  const tabs = createTabActions(store, api);
  const flows = createFileFlows({ store, api, tabs, dialogs });
  tabs.setBeforeClose((tabId) => flows.beforeClose(tabId));
  /** Answers the next confirm dialog with the given button id. */
  const answer = async (buttonId: string) => {
    for (let i = 0; i < 50 && store.getState().modal?.kind !== "confirm"; i++) await Bun.sleep(1);
    const modal = store.getState().modal;
    if (modal?.kind !== "confirm") throw new Error("no confirm dialog open");
    dialogs.resolve(modal.id, buttonId);
    return modal;
  };
  return { store, api, dialogs, tabs, flows, answer };
}

describe("confirm dialog focus (FB-m2)", () => {
  const buttons = [
    { id: "discard", label: "Don't Save" },
    { id: "cancel", label: "Cancel", role: "cancel" as const },
    { id: "save", label: "Save", role: "primary" as const },
  ];

  test("closing returns focus to the opener, or to the editor when the opener is gone", async () => {
    const { store, dialogs } = setup();
    render(createElement(ConfirmDialog, { store, dialogs }));
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    try {
      opener.focus();
      let choice: Promise<string> = Promise.resolve("");
      act(() => {
        choice = dialogs.confirm({ title: "Save changes?", message: "M", buttons });
      });
      expect(document.activeElement?.textContent).toBe("Save");
      act(() => {
        fireEvent.keyDown(document.body, { key: "Escape" });
      });
      expect([await choice, document.activeElement]).toEqual(["cancel", opener]);

      const editorFocus = mock(() => {});
      setEditorHandle({ focus: editorFocus } as unknown as EditorHandle);
      act(() => {
        choice = dialogs.confirm({ title: "Again?", message: "M", buttons });
      });
      opener.remove();
      act(() => {
        fireEvent.keyDown(document.body, { key: "Escape" });
      });
      expect([await choice, editorFocus.mock.calls.length]).toEqual(["cancel", 1]);
    } finally {
      setEditorHandle(null);
      opener.remove();
    }
  });

  test("Tab and Shift+Tab cycle through the dialog's buttons and never leave the dialog", () => {
    const { store, dialogs } = setup();
    render(createElement(ConfirmDialog, { store, dialogs }));
    act(() => {
      void dialogs.confirm({ title: "Save changes?", message: "M", buttons });
    });
    const focused = () => document.activeElement?.textContent;
    expect(focused()).toBe("Save");
    expect(fireEvent.keyDown(document.activeElement as Element, { key: "Tab" })).toBe(false);
    expect(focused()).toBe("Don't Save");
    fireEvent.keyDown(document.activeElement as Element, { key: "Tab" });
    expect(focused()).toBe("Cancel");
    fireEvent.keyDown(document.activeElement as Element, { key: "Tab", shiftKey: true });
    fireEvent.keyDown(document.activeElement as Element, { key: "Tab", shiftKey: true });
    expect(focused()).toBe("Save");
    (document.activeElement as HTMLElement).blur();
    fireEvent.keyDown(document.body, { key: "Tab" });
    expect(focused()).toBe("Don't Save");
  });
});

describe("file flows", () => {
  test("sizes format like Finder, and confirm dialogs resolve by button", async () => {
    expect([formatSize(512), formatSize(5 * 1024 * 1024), formatSize(13_000_000)]).toEqual([
      "512 B",
      "5.0 MB",
      "12.4 MB",
    ]);
    const { dialogs, store } = setup();
    const choice = dialogs.confirm({
      title: "T",
      message: "M",
      buttons: [{ id: "cancel", label: "Cancel", role: "cancel" }],
    });
    const modal = store.getState().modal;
    expect(modal).toMatchObject({ kind: "confirm", title: "T" });
    dialogs.resolve(modal?.kind === "confirm" ? modal.id : "", "cancel");
    expect([await choice, store.getState().modal]).toEqual(["cancel", null]);

    // m-5: Escape still cancels after a click on the backdrop moved focus off the dialog's buttons.
    render(createElement(ConfirmDialog, { store, dialogs }));
    let escaped: Promise<string> = Promise.resolve("not asked");
    act(() => {
      escaped = dialogs.confirm({
        title: "T2",
        message: "M",
        buttons: [
          { id: "cancel", label: "Cancel", role: "cancel" },
          { id: "ok", label: "OK", role: "primary" },
        ],
      });
    });
    fireEvent.mouseDown(document.querySelector(".dialog-backdrop") as Element);
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect([await escaped, store.getState().modal]).toEqual(["cancel", null]);
  });

  test("Save writes saved files in place; scratch tabs go through Save As until Main answers", async () => {
    const { flows, api, store } = setup();
    api.saveFile.mockImplementation(async (tabId: string) =>
      tabId === "saved"
        ? { ok: true as const, tab: createTab({ id: "saved", filePath: "/w/a.ts", lastSavedHash: contentHash("v2") }) }
        : { needsSaveAs: true as const },
    );
    store.getState().editCode("v2", "saved");
    expect(await flows.save("saved")).toBe(true);
    expect(store.getState().tabs.saved?.lastSavedHash).toBe(contentHash("v2"));

    const pending = flows.save("scratch");
    await Bun.sleep(1);
    expect(api.saveAsDialog).toHaveBeenCalledWith("scratch", "1 + 1");
    flows.handleSaved({
      tabId: "scratch",
      tab: createTab({ id: "scratch", filePath: "/w/new.ts", lastSavedHash: "h" }),
    });
    expect([await pending, store.getState().tabs.scratch?.filePath]).toEqual([true, "/w/new.ts"]);

    const cancelled = flows.saveAs("saved");
    await Bun.sleep(1);
    flows.handleSaveCancelled({ tabId: "saved" });
    expect(await cancelled).toBe(false);

    // A tab closed mid-dialog: Main answers file.saveFailed ("That tab is no longer open."), which settles Save As.
    const gone = flows.saveAs("saved");
    await Bun.sleep(1);
    flows.handleSaveFailed({ tabId: "saved", error: "That tab is no longer open." });
    expect([await gone, store.getState().statusMessage]).toEqual([false, "Couldn't save: That tab is no longer open."]);
  });

  test("closing asks to save modified files, honours Confirm Close, and closes the window for a lone empty tab", async () => {
    const { tabs, api, store, answer } = setup(mergeSettings(defaultSettings(), { tabs: { confirmClose: true } }));
    api.closeTab.mockImplementation(async () => ({ ok: true, activeTabId: "scratch", replacement: null }));
    store.getState().editCode("changed", "saved");
    const cancel = tabs.close("saved");
    expect((await answer("cancel")).title).toBe("Save changes to a.ts?");
    expect(await cancel).toBe(false);
    const discard = tabs.close("saved");
    await answer("discard");
    expect(await discard).toBe(true);
    expect(store.getState().tabOrder).toEqual(["scratch"]);

    store.getState().editCode("", "scratch");
    expect(await tabs.close("scratch")).toBe(false);
    expect(api.appCommand).toHaveBeenCalledWith("closeWindow");

    store.getState().editCode("x", "scratch");
    const confirmClose = tabs.close("scratch");
    expect((await answer("cancel")).title).toBe('Close "x"?');
    expect(await confirmClose).toBe(false);
  });

  /**
   * R-M5E-DT-1: `file-flows.ts:126` calls `deriveTitle(tab, code)` with no third argument, so the "Save
   * changes?" / "Close ...?" dialog title fell back to deriveTitle's own hard-coded English default for an
   * empty, fileless tab -- even though the localized string already exists at `strings.tabs.untitled`.
   */
  test("the close confirmation for an empty, untitled tab shows the localized fallback (i18n)", async () => {
    const { tabs, store, answer } = setup(mergeSettings(defaultSettings(), { tabs: { confirmClose: true } }));
    // Two tabs stay open ("scratch" and "saved"), so closing "scratch" hits the confirmClose dialog rather
    // than TF-21's lone-untouched-tab closeWindow shortcut.
    store.getState().editCode("", "scratch");
    const original = strings.tabs.untitled;
    (strings.tabs as { untitled: string }).untitled = "無題";
    try {
      const closing = tabs.close("scratch");
      expect((await answer("close")).title).toBe('Close "無題"?');
      expect(await closing).toBe(true);
    } finally {
      (strings.tabs as { untitled: string }).untitled = original;
    }
  });

  /**
   * R-M5a-REGRESSION-2. Before the welcome tab (spec §7.5) a first launch's only tab was empty, so TF-21's
   * "empty" test and "untouched" were the same thing. They no longer are: the welcome tab is untouched but full
   * of sample code, and testing emptiness there closes the TAB and leaves a first-run user looking at an empty
   * window. The guard has to test pristineness instead.
   */
  test("⌘W closes the window for a lone untouched tab, empty or not, and stops once it is edited (TF-21)", async () => {
    const welcome = "// Welcome to JSLab\nconst answer = 42\n";
    const { flows, api, store } = setup(defaultSettings(), {
      tab: createTab({ id: "scratch", pristine: true }),
      content: welcome,
    });

    expect(await flows.beforeClose("scratch")).toBe(false);
    expect(api.appCommand).toHaveBeenCalledWith("closeWindow");

    // The moment the user types, the tab is theirs, and ⌘W goes back to being an ordinary tab close.
    api.appCommand.mockClear();
    store.getState().editCode(`${welcome}const mine = 1\n`, "scratch");
    expect(store.getState().tabs.scratch?.pristine).toBe(false);
    expect(await flows.beforeClose("scratch")).toBe(true);
    expect(api.appCommand).not.toHaveBeenCalledWith("closeWindow");
  });

  test("opened files become tabs; errors show; large files need confirmation", async () => {
    const { flows, api, store, answer } = setup();
    const opened = flows.handleOpened({
      tabs: [{ tab: createTab({ id: "o1", filePath: "/w/o1.ts" }), content: "o" }],
      focusTabId: null,
      large: [{ token: "11111111-1111-4111-8111-111111111111", path: "/w/big.js", size: 13_000_000 }],
      errors: ["img.txt isn't a text file."],
    });
    const modal = await answer("open");
    expect(modal.message).toBe("big.js is 12.4 MB. Large files can make JSLab slow.");
    await opened;
    expect(store.getState().activeTabId).toBe("o1");
    expect(store.getState().statusMessage).toBe("img.txt isn't a text file.");
    expect(api.confirmLargeFiles).toHaveBeenCalledWith(["11111111-1111-4111-8111-111111111111"]);
    await flows.handleOpened({ tabs: [], focusTabId: "saved", large: [], errors: [] });
    expect(store.getState().activeTabId).toBe("saved");
  });

  test("Main's save-as confirmation is answered from a dialog", async () => {
    const { flows, api, answer } = setup();
    const token = "22222222-2222-4222-8222-222222222222";
    const yes = flows.handleSaveAsConfirm({ token, tabId: "scratch", path: "/w/Untitled.ts" });
    expect((await answer("save")).message).toBe("Save as /w/Untitled.ts?");
    await yes;
    const no = flows.handleSaveAsConfirm({ token, tabId: "scratch", path: "/w/Untitled.ts" });
    await answer("cancel");
    await no;
    expect(api.confirmSaveAs.mock.calls).toEqual([
      [token, true],
      [token, false],
    ]);
  });

  // Task 18 fix round 1 (I-2): menu commands and Main messages can open a modal while a confirm is showing.
  test("a confirm replaced by another modal settles as cancelled, so closes and Save As confirmations never hang", async () => {
    const { tabs, flows, api, dialogs, store } = setup();
    const confirmShown = async () => {
      for (let i = 0; i < 50 && store.getState().modal?.kind !== "confirm"; i++) await Bun.sleep(1);
    };
    store.getState().editCode("changed", "saved");
    const closing = tabs.close("saved");
    await confirmShown();
    const second = dialogs.confirm({
      title: "Second",
      message: "M",
      buttons: [
        { id: "no", label: "No", role: "cancel" },
        { id: "yes", label: "Yes", role: "primary" },
      ],
    });
    expect([await closing, "saved" in store.getState().tabs]).toEqual([false, true]);
    expect(api.closeTab).not.toHaveBeenCalled();
    expect(store.getState().modal).toMatchObject({ kind: "confirm", title: "Second" });
    store.getState().openModal({ kind: "rename", tabId: "saved" });
    expect(await second).toBe("no");

    const token = "33333333-3333-4333-8333-333333333333";
    store.getState().closeModal();
    const asked = flows.handleSaveAsConfirm({ token, tabId: "scratch", path: "/w/Untitled.ts" });
    await confirmShown();
    store.getState().openModal({ kind: "palette", context: "editor" });
    await asked;
    expect(api.confirmSaveAs.mock.calls).toEqual([[token, false]]);
  });

  test("dropped text files open as tabs; binaries, folders and files over 50 MB are refused; big files ask first", async () => {
    const { flows, api, store, answer } = setup();
    api.createTab.mockImplementation(async (params) => ({
      tab: createTab({ id: params.title ?? "x", language: params.language }),
    }));
    const text = new File(["const a = 1"], "notes.tsx");
    const binary = new File([new Uint8Array([0x89, 0x00, 0x41])], "pic.png");
    const big = new File(["x"], "big.js");
    Object.defineProperty(big, "size", { value: 6 * 1024 * 1024 });
    const huge = new File(["x"], "huge.js");
    Object.defineProperty(huge, "size", { value: 60 * 1024 * 1024 });
    const dropping = flows.dropFiles([text, binary, big, huge], new Set(["assets"]));
    await answer("cancel");
    await dropping;
    expect(api.createTab.mock.calls).toEqual([
      [{ title: "notes.tsx", titleIsCustom: true, language: "tsx", content: "const a = 1" }],
    ]);
    expect(store.getState().statusMessage).toBe(
      `pic.png isn't a text file. · huge.js is larger than 50 MB and can't be opened. · ${strings.files.folderDrop}`,
    );
  });

  test("format on save runs before the content is saved", async () => {
    const store = createAppStore();
    store.getState().hydrate({
      settings: mergeSettings(defaultSettings(), { editor: { formatOnSave: true } }),
      session: defaultSession(() => createTab({ id: "f", filePath: "/w/f.ts", lastSavedHash: "old" })),
      buffers: { f: "let x=1" },
      safeMode: { active: false, reason: null },
      versions: { app: "0", bun: "1.4.0" },
    });
    const { api } = createFakeApi();
    api.saveFile.mockImplementation(async (_id: string, content: string) => ({
      ok: true as const,
      tab: createTab({ id: "f", filePath: "/w/f.ts", lastSavedHash: contentHash(content) }),
    }));
    const tabs = createTabActions(store, api);
    const beforeSave = mock(async (tabId: string) => {
      store.getState().editCode("let x = 1;\n", tabId);
    });
    const flows = createFileFlows({ store, api, tabs, dialogs: createDialogs(store), beforeSave });
    expect(await flows.save("f")).toBe(true);
    expect(beforeSave).toHaveBeenCalledWith("f");
    expect(api.saveFile).toHaveBeenCalledWith("f", "let x = 1;\n");
  });

  // m-5 (fix round 1): correct the earlier report's claim that formatOnSave was covered on the
  // needsSaveAs (scratch-tab) path. This exercises `save()` on a fileless tab, whose result is
  // `needsSaveAs`, and asserts `beforeSave` ran exactly once (no double format on that fallback).
  test("format on save runs once before a scratch tab falls through to Save As", async () => {
    const store = createAppStore();
    store.getState().hydrate({
      settings: mergeSettings(defaultSettings(), { editor: { formatOnSave: true } }),
      session: defaultSession(() => createTab({ id: "scratch" })),
      buffers: { scratch: "let x=1" },
      safeMode: { active: false, reason: null },
      versions: { app: "0", bun: "1.4.0" },
    });
    // fake-api's default saveFile resolves { needsSaveAs: true }.
    const { api } = createFakeApi();
    const tabs = createTabActions(store, api);
    const beforeSave = mock(async (tabId: string) => {
      store.getState().editCode("let x = 1;\n", tabId);
    });
    const flows = createFileFlows({ store, api, tabs, dialogs: createDialogs(store), beforeSave });
    const pending = flows.save("scratch");
    await Bun.sleep(1);
    expect(beforeSave).toHaveBeenCalledTimes(1);
    expect(api.saveAsDialog).toHaveBeenCalledWith("scratch", "let x = 1;\n");
    flows.handleSaveCancelled({ tabId: "scratch" });
    expect(await pending).toBe(false);
  });

  // I-3 (fix round 1): formatForSave is always async (even with Format on Save off), so there is a gap
  // between saveAs's leading finishSave and its waiters.set. A second saveAs for the same tab, arriving
  // during that gap, must settle the first call instead of silently dropping it.
  test("a second Save As for the same tab settles the first one even with Format on Save off (I-3)", async () => {
    const { flows, api } = setup();
    const first = flows.saveAs("saved");
    const second = flows.saveAs("saved");
    expect(await first).toBe(false);
    expect(api.saveAsDialog).toHaveBeenCalledTimes(2);
    flows.handleSaveCancelled({ tabId: "saved" });
    expect(await second).toBe(false);
  });

  test("a second Save As for the same tab settles the first one while a slow format is running (I-3)", async () => {
    const store = createAppStore();
    store.getState().hydrate({
      settings: mergeSettings(defaultSettings(), { editor: { formatOnSave: true } }),
      session: defaultSession(() => createTab({ id: "f", filePath: "/w/f.ts", lastSavedHash: "old" })),
      buffers: { f: "let x=1" },
      safeMode: { active: false, reason: null },
      versions: { app: "0", bun: "1.4.0" },
    });
    const { api } = createFakeApi();
    const tabs = createTabActions(store, api);
    // Both saveAs calls await the same gate, so they resolve (and their .then continuations run) in the
    // order they were made -- exactly the "format still running" race I-3 is about.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const beforeSave = mock(() => gate);
    const flows = createFileFlows({ store, api, tabs, dialogs: createDialogs(store), beforeSave });
    const first = flows.saveAs("f");
    const second = flows.saveAs("f");
    release();
    expect(await first).toBe(false);
    expect(api.saveAsDialog).toHaveBeenCalledTimes(2);
    flows.handleSaveCancelled({ tabId: "f" });
    expect(await second).toBe(false);
  });
});

describe("folder drops (R-M3-SPIKE-1 Branch B)", () => {
  test("a dropped folder points at Set Working Directory", async () => {
    const { store, flows } = setup();
    await flows.dropFiles([new File([""], "api")], new Set(["api"]));
    expect(store.getState().statusMessage).toBe(strings.files.folderDrop);
  });
});
