import { describe, expect, test } from "bun:test";
import type { BootstrapPayload } from "@jslab/rpc-schema";
import { contentHash, createTab, defaultSession, defaultSettings, isDirty } from "@jslab/shared";
import { snapshotState } from "../src/e2e/snapshot";
import { createFileFlows } from "../src/files/file-flows";
import { createDialogs } from "../src/shell/dialogs";
import { createAppStore } from "../src/state/store";
import { strings } from "../src/strings";
import { createTabActions } from "../src/tabs/tab-actions";
import { createFakeApi } from "./fake-api";

/**
 * B1: the UI half of "a tab whose buffer couldn't be read must never be written back".
 *
 * Main omits such a tab from `bootstrap.buffers` deliberately -- "simply absent rather than invented as empty".
 * The UI then filled the gap with `""` one layer up, and that placeholder was indistinguishable from a genuinely
 * empty file: `isDirty` compared it against the REAL file's `lastSavedHash`, called the tab modified, and ⌘W
 * offered "Save" as the primary button. Pressing it sent `file.save(tabId, "")`, which truncated the user's
 * source file to zero bytes with no `.bak`.
 *
 * (The real-disk truncation, and Main's own independent refusal, are pinned in
 * `apps/desktop/test/files/save-truncation.test.ts`. These tests cover the half that lives here: the UI must not
 * report such a tab dirty, must not offer or send a save for it, and must make it visible to the user.)
 */

const REAL = "export const answer = 42;\n";

/** t1: an ordinary scratch tab. t2: file-backed, whose buffer file Main could not read. */
function payload(overrides: Partial<BootstrapPayload> = {}): BootstrapPayload {
  const t1 = createTab({ id: "t1" });
  const t2 = createTab({ id: "t2", filePath: "/w/app.ts", lastSavedHash: contentHash(REAL) });
  const base = defaultSession(() => t1);
  return {
    settings: defaultSettings(),
    session: { ...base, tabs: { t1, t2 }, tabOrder: ["t1", "t2"], activeTabId: "t2" },
    // t2 is absent, exactly as Main leaves it.
    buffers: { t1: "1 + 1" },
    unreadableBuffers: ["t2"],
    safeMode: { active: false, reason: null },
    versions: { app: "0", bun: "1.4.0" },
    ...overrides,
  };
}

function setup(bootstrap: BootstrapPayload = payload()) {
  const store = createAppStore();
  store.getState().hydrate(bootstrap);
  const { api } = createFakeApi();
  const dialogs = createDialogs(store);
  const tabs = createTabActions(store, api);
  const flows = createFileFlows({ store, api, tabs, dialogs });
  return { store, api, dialogs, tabs, flows };
}

describe("a tab whose buffer couldn't be read (B1)", () => {
  test("is marked unreadable instead of being invented as an empty buffer", () => {
    const { store } = setup();
    expect(store.getState().unreadableBuffers).toEqual(["t2"]);
    // The placeholder is still a string, so nothing downstream has to handle `undefined` -- it is simply labelled.
    expect(store.getState().buffers.t2).toBe("");
  });

  test("is not reported dirty, though the raw comparison that used to decide it still says modified", () => {
    const { store } = setup();
    const tab = store.getState().tabs.t2;
    if (!tab) throw new Error("expected tab t2");

    // The trap itself, still true: this is what the UI used to ask, and why the tab looked like an unsaved edit.
    expect(isDirty(tab, "")).toBe(true);

    // What the UI reports now.
    const snapshot = snapshotState(store.getState()).tabs.find((entry) => entry.id === "t2");
    expect(snapshot).toMatchObject({ unreadable: true, dirty: false });
  });

  test("⌘S neither writes nor even asks Main, and says why", async () => {
    const { flows, api, store } = setup();
    expect(await flows.save("t2")).toBe(false);
    expect(api.saveFile).not.toHaveBeenCalled();
    expect(store.getState().statusMessage).toBe(strings.files.unreadableBuffer);
  });

  test("Save As is refused too, so the placeholder is never written anywhere", async () => {
    const { flows, api, store } = setup();
    expect(await flows.saveAs("t2")).toBe(false);
    expect(api.saveAsDialog).not.toHaveBeenCalled();
    expect(store.getState().statusMessage).toBe(strings.files.unreadableBuffer);
  });

  /**
   * The step that actually reached most users: ⌘W raised "Save changes?" with Save as `role: "primary"`, so the
   * default action truncated the file. Closing such a tab loses nothing, because nothing was ever read.
   */
  test("closing it raises no Save changes? prompt", async () => {
    const { flows, store } = setup();
    expect(await flows.beforeClose("t2")).toBe(true);
    expect(store.getState().modal).toBeNull();
  });

  test("an edit arriving from anywhere cannot turn the placeholder into saveable content", () => {
    const { store } = setup();
    store.getState().editCode("something the user never typed", "t2");
    expect(store.getState().buffers.t2).toBe("");
  });

  /**
   * Defence against the two halves drifting: a tab missing from `buffers` is unreadable by construction, whether
   * or not Main remembered to name it. A future Main that dropped `unreadableBuffers` would otherwise silently
   * restore the original bug.
   */
  test("a tab missing from buffers is marked even when Main sends no ids at all", () => {
    const { unreadableBuffers: _omitted, ...withoutIds } = payload();
    const { store } = setup(withoutIds as BootstrapPayload);
    expect(store.getState().unreadableBuffers).toEqual(["t2"]);
  });

  /**
   * `openTab` for an id that is ALREADY open only re-activates it -- it delivers no content (and Main's
   * `findTabByPath` short-circuits an open path to a focus request for the same reason). So this must NOT clear
   * the mark: doing so would unlock saving while the buffer is still the placeholder, which is the whole bug.
   */
  test("re-opening the same tab id does not unlock it while it still holds the placeholder", async () => {
    const { store, flows, api } = setup();
    const tab = store.getState().tabs.t2;
    if (!tab) throw new Error("expected tab t2");

    store.getState().openTab(tab, REAL, true);

    expect(store.getState().unreadableBuffers).toEqual(["t2"]);
    expect(store.getState().buffers.t2).toBe("");
    expect(await flows.save("t2")).toBe(false);
    expect(api.saveFile).not.toHaveBeenCalled();
  });

  /** The recovery that does work: the tab is closed (which forgets it), then the file is opened fresh. */
  test("closing it forgets the mark, so opening the file again gives a normal, savable tab", async () => {
    const { store, flows, api } = setup();
    store.getState().removeTab("t2");
    expect(store.getState().unreadableBuffers).toEqual([]);

    const reopened = createTab({ id: "t3", filePath: "/w/app.ts", lastSavedHash: contentHash(REAL) });
    api.saveFile.mockImplementation(async () => ({ ok: true as const, tab: reopened }));
    store.getState().openTab(reopened, REAL, true);

    expect(store.getState().buffers.t3).toBe(REAL);
    expect(await flows.save("t3")).toBe(true);
    expect(api.saveFile).toHaveBeenCalledWith("t3", REAL);
  });

  test("a readable tab in the same session is unaffected", async () => {
    const { store, flows, api } = setup();
    const t1 = store.getState().tabs.t1;
    if (!t1) throw new Error("expected tab t1");
    api.saveFile.mockImplementation(async () => ({ ok: true as const, tab: t1 }));

    store.getState().editCode("2 + 2", "t1");
    expect(store.getState().buffers.t1).toBe("2 + 2");
    expect(await flows.save("t1")).toBe(true);
    expect(api.saveFile).toHaveBeenCalledWith("t1", "2 + 2");
  });
});
