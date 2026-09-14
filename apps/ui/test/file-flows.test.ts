import { describe, expect, test } from "bun:test";
import { contentHash, createTab, defaultSession, defaultSettings, mergeSettings } from "@jslab/shared";
import { createFileFlows, formatSize } from "../src/files/file-flows";
import { createDialogs } from "../src/shell/dialogs";
import { createAppStore } from "../src/state/store";
import { createTabActions } from "../src/tabs/tab-actions";
import { createFakeApi } from "./fake-api";

function setup(settings = defaultSettings()) {
  const store = createAppStore();
  store.getState().hydrate({
    settings,
    session: defaultSession(() => createTab({ id: "scratch" })),
    buffers: { scratch: "1 + 1" },
    safeMode: { active: false, reason: null },
    versions: { app: "0", bun: "1.4.0" },
  });
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
      "pic.png isn't a text file. · huge.js is larger than 50 MB and can't be opened. · Dropping a folder sets the working directory, which arrives with working directories.",
    );
  });
});
