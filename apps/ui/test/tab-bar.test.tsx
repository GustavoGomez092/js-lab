import { describe, expect, mock, test } from "bun:test";
import { contentHash, createTab, defaultSession, defaultSettings, isDirty, type TabState } from "@jslab/shared";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { createAppStore } from "../src/state/store";
import { strings } from "../src/strings";
import { RenameDialog } from "../src/tabs/RenameDialog";
import { reorderByDrop } from "../src/tabs/reorder";
import { TabBar } from "../src/tabs/TabBar";
import type { TabActions } from "../src/tabs/tab-actions";
import { createTabSummaryCache } from "../src/tabs/tab-summary";
import { createFakeApi } from "./fake-api";

/** Mutates the real `strings.tabs.untitled` for the duration of `run`, then restores it (R-M5E-DT-1). */
async function withLocalizedUntitled<T>(value: string, run: () => T | Promise<T>): Promise<T> {
  const original = strings.tabs.untitled;
  (strings.tabs as { untitled: string }).untitled = value;
  try {
    return await run();
  } finally {
    (strings.tabs as { untitled: string }).untitled = original;
  }
}

function fakeTabActions() {
  return {
    activate: mock((_id: string | null) => {}),
    close: mock(async (_id?: string) => true),
    closeOthers: mock(async (_id?: string) => {}),
    closeToRight: mock(async (_id?: string) => {}),
    newTab: mock(async () => {}),
    reopen: mock(async () => {}),
    next: mock(() => {}),
    previous: mock(() => {}),
    goto: mock((_n: number) => {}),
    reorder: mock((_order: string[]) => {}),
    setBeforeClose: mock((_guard: (id: string) => Promise<boolean>) => {}),
  } satisfies TabActions;
}

function setup() {
  const store = createAppStore();
  store.getState().hydrate({
    settings: defaultSettings(),
    session: defaultSession(() => createTab({ id: "a" })),
    buffers: { a: "const answer = 42\nanswer" },
    safeMode: { active: false, reason: null },
    versions: { app: "0", bun: "1.4.0" },
  });
  act(() => {
    // Background tabs go right after the active tab, so open "c" first to get the order a, b, c.
    store.getState().openTab(createTab({ id: "c", title: "Mine", titleIsCustom: true }), "", false);
    store
      .getState()
      .openTab(
        createTab({ id: "b", filePath: "/work/users.ts", lastSavedHash: contentHash("saved") }),
        "edited",
        false,
      );
  });
  const tabs = fakeTabActions();
  const { api } = createFakeApi();
  render(<TabBar store={store} tabs={tabs} api={api} />);
  return { store, tabs, api };
}

describe("tab summaries (FB-I2)", () => {
  test("title and dirty state are computed once per buffer string, and again only when the buffer or tab changes", () => {
    const title = mock((_tab: TabState, code: string) => `t:${code.length}`);
    const dirty = mock((_tab: TabState, code: string) => code !== "saved");
    const cache = createTabSummaryCache({ title, dirty });
    const file = createTab({ id: "f", filePath: "/work/a.ts", lastSavedHash: contentHash("saved") });
    const big = "x".repeat(10_000);
    expect([cache.title(file, big), cache.dirty(file, big)]).toEqual(["t:10000", true]);
    // A second render with the same buffer string, and a tab object replaced by a view-state commit, are hits.
    const committed: TabState = { ...file, viewState: { top: 1 } };
    expect([cache.title(committed, big), cache.dirty(file, big)]).toEqual(["t:10000", true]);
    expect([title.mock.calls.length, dirty.mock.calls.length]).toEqual([1, 1]);
    // An edit (a new buffer string) or a save (a new lastSavedHash) recomputes.
    cache.dirty(file, "saved");
    cache.dirty({ ...file, lastSavedHash: contentHash("other") }, "saved");
    expect(dirty.mock.calls.length).toBe(3);
    cache.retain(new Set());
    cache.title(file, "saved");
    expect(title.mock.calls.length).toBe(2);
  });
});

describe("tab bar", () => {
  test("drops place the dragged tab before or after the target", () => {
    const order = ["a", "b", "c", "d"];
    expect(reorderByDrop(order, "a", "c", false)).toEqual(["b", "a", "c", "d"]);
    expect(reorderByDrop(order, "a", "c", true)).toEqual(["b", "c", "a", "d"]);
    expect(reorderByDrop(order, "d", "a", false)).toEqual(["d", "a", "b", "c"]);
    expect(reorderByDrop(order, "b", "b", true)).toEqual(order);
    expect(reorderByDrop(order, "zz", "a", false)).toEqual(order);
  });

  test("tabs show derived titles, a dirty dot and path tooltip for saved files, and close by button or middle click", () => {
    const { tabs } = setup();
    const all = screen.getAllByRole("tab");
    expect(all.map((tab) => tab.textContent?.replace("×", ""))).toEqual(["const answer = 42", "users.ts", "Mine"]);
    expect(all[0]?.getAttribute("aria-selected")).toBe("true");
    expect(all[1]?.getAttribute("title")).toBe("/work/users.ts");
    expect(all[1]?.querySelector(".tab-dirty")).not.toBeNull();
    expect(all[2]?.querySelector(".tab-dirty")).toBeNull();
    fireEvent.click(all[1] as HTMLElement);
    expect(tabs.activate).toHaveBeenCalledWith("b");
    fireEvent.click(screen.getByRole("button", { name: "Close Mine" }));
    fireEvent(all[0] as HTMLElement, new MouseEvent("auxclick", { bubbles: true, button: 1 }));
    expect(tabs.close.mock.calls).toEqual([["c"], ["a"]]);
    fireEvent.click(screen.getByRole("button", { name: "New Tab" }));
    expect(tabs.newTab).toHaveBeenCalledTimes(1);
  });

  test("a drag that ends without a drop clears the drop indicator (I-1)", () => {
    setup();
    const all = screen.getAllByRole("tab");
    const dataTransfer = new DataTransfer();
    fireEvent.dragStart(all[0] as HTMLElement, { dataTransfer });
    fireEvent.dragOver(all[1] as HTMLElement, { dataTransfer, clientX: 0 });
    expect(all[1]?.className).toContain("drop-before");
    // Escape mid-drag, or releasing over the editor/output/"+" button, fires dragend without a drop.
    fireEvent.dragEnd(all[0] as HTMLElement, { dataTransfer });
    const classes = screen.getAllByRole("tab").map((tab) => tab.className);
    expect(classes.some((className) => className.includes("drop-before") || className.includes("drop-after"))).toBe(
      false,
    );
  });

  test("the context menu enables file actions only for saved files and runs the chosen action", () => {
    const { tabs, api, store } = setup();
    const [first, second] = screen.getAllByRole("tab");
    fireEvent.contextMenu(first as HTMLElement, { clientX: 10, clientY: 10 });
    const items = () =>
      screen.getAllByRole("menuitem").map((item) => [item.textContent, (item as HTMLButtonElement).disabled]);
    expect(items()).toEqual([
      ["Rename…", false],
      ["Close", false],
      ["Close Others", false],
      ["Close to the Right", false],
      ["Reveal in Finder", true],
      ["Copy Path", true],
    ]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename…" }));
    expect(store.getState().modal).toEqual({ kind: "rename", tabId: "a" });
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.contextMenu(second as HTMLElement, { clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByRole("menuitem", { name: "Reveal in Finder" }));
    expect(api.revealInFinder).toHaveBeenCalledWith("b");
    fireEvent.contextMenu(second as HTMLElement, { clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByRole("menuitem", { name: "Close Others" }));
    expect(tabs.closeOthers).toHaveBeenCalledWith("b");
  });

  test("the rename dialog saves on submit, and Escape cancels", () => {
    const store = createAppStore();
    store.getState().hydrate({
      settings: defaultSettings(),
      session: defaultSession(() => createTab({ id: "a" })),
      buffers: { a: "1 + 1" },
      safeMode: { active: false, reason: null },
      versions: { app: "0", bun: "1.4.0" },
    });
    render(<RenameDialog store={store} />);
    act(() => store.getState().openModal({ kind: "rename", tabId: "a" }));
    const input = screen.getByLabelText("Tab name") as HTMLInputElement;
    expect(input.value).toBe("1 + 1");
    fireEvent.change(input, { target: { value: "sums" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    expect([store.getState().tab?.title, store.getState().modal]).toEqual(["sums", null]);
    // m-1: rename returns focus to whatever had it before the dialog opened (here, a tab button)
    // instead of stranding it on the (now unmounted) dialog.
    const tabButton = document.createElement("button");
    document.body.appendChild(tabButton);
    tabButton.focus();
    act(() => store.getState().openModal({ kind: "rename", tabId: "a" }));
    fireEvent.change(screen.getByLabelText("Tab name"), { target: { value: "ignored" } });
    fireEvent.keyDown(screen.getByLabelText("Tab name"), { key: "Escape" });
    expect([store.getState().tab?.title, store.getState().modal]).toEqual(["sums", null]);
    expect(document.activeElement).toBe(tabButton);
    tabButton.remove();
  });
});

/**
 * B1: the unsaved-changes dot is the visual invitation to press ⌘S, and pressing it on a tab holding a placeholder
 * is what truncated the user's file. Such a tab must never show the dot -- even though the raw comparison still
 * reports it modified, because the placeholder differs from the real file's saved hash.
 */
describe("a tab whose buffer couldn't be read (B1)", () => {
  const REAL = "export const answer = 42;\n";

  test("shows no unsaved-changes dot, though a genuinely edited tab still does", () => {
    const store = createAppStore();
    const unreadable = createTab({ id: "u", filePath: "/w/app.ts", lastSavedHash: contentHash(REAL) });
    const edited = createTab({ id: "e", filePath: "/w/other.ts", lastSavedHash: contentHash("saved") });
    const base = defaultSession(() => unreadable);
    store.getState().hydrate({
      settings: defaultSettings(),
      session: { ...base, tabs: { u: unreadable, e: edited }, tabOrder: ["u", "e"], activeTabId: "u" },
      // "u" is absent, exactly as Main leaves a tab whose buffer it couldn't read.
      buffers: { e: "edited" },
      unreadableBuffers: ["u"],
      safeMode: { active: false, reason: null },
      versions: { app: "0", bun: "1.4.0" },
    });
    const { api } = createFakeApi();
    render(<TabBar store={store} tabs={fakeTabActions()} api={api} />);

    // The trap itself, still true: the placeholder differs from the real file's hash, so the raw check says modified.
    expect(isDirty(unreadable, "")).toBe(true);

    const [u, e] = screen.getAllByRole("tab");
    expect(u?.querySelector(".tab-dirty")).toBeNull();
    expect(e?.querySelector(".tab-dirty")).not.toBeNull();
  });
});

describe("working directory label (EX-33)", () => {
  test("a tab with a working directory shows the folder name after its title", () => {
    const { store } = setup();
    act(() =>
      store.getState().applyTabUpdate({ ...(store.getState().tabs.c as TabState), workingDirectory: "/work/api" }),
    );
    expect(screen.getByText("Mine · api")).toBeTruthy();
  });
});

/**
 * R-M5E-DT-1: the headline defect. `TabBar.tsx:67` calls `summaries.title(tab, code)`, and until this fix
 * `tab-summary.ts:31` wired that up to a BARE `deriveTitle` reference -- so an empty, fileless, non-custom
 * tab always showed deriveTitle's own hard-coded English default ("Untitled"), never the localized string
 * that already exists at `strings.tabs.untitled`, no matter what language the app is running in.
 */
describe("an untitled tab's label is localized (R-M5E-DT-1)", () => {
  function setupEmptyTab() {
    const store = createAppStore();
    store.getState().hydrate({
      settings: defaultSettings(),
      session: defaultSession(() => createTab({ id: "empty" })),
      buffers: { empty: "" },
      safeMode: { active: false, reason: null },
      versions: { app: "0", bun: "1.4.0" },
    });
    const { api } = createFakeApi();
    render(<TabBar store={store} tabs={fakeTabActions()} api={api} />);
  }

  test("the real tab bar shows the current locale's fallback, not the English literal", async () => {
    await withLocalizedUntitled("無題", () => {
      setupEmptyTab();
      const tab = screen.getByRole("tab");
      expect(tab.textContent?.replace("×", "")).toBe("無題");
    });
  });

  test("the rename dialog pre-fills the current locale's fallback for the same tab", async () => {
    await withLocalizedUntitled("無題", () => {
      const store = createAppStore();
      store.getState().hydrate({
        settings: defaultSettings(),
        session: defaultSession(() => createTab({ id: "empty" })),
        buffers: { empty: "" },
        safeMode: { active: false, reason: null },
        versions: { app: "0", bun: "1.4.0" },
      });
      render(<RenameDialog store={store} />);
      act(() => store.getState().openModal({ kind: "rename", tabId: "empty" }));
      const input = screen.getByLabelText("Tab name") as HTMLInputElement;
      expect(input.value).toBe("無題");
    });
  });
});
