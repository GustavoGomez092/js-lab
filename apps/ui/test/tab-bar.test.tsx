import { describe, expect, mock, test } from "bun:test";
import { contentHash, createTab, defaultSession, defaultSettings } from "@jslab/shared";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { createAppStore } from "../src/state/store";
import { RenameDialog } from "../src/tabs/RenameDialog";
import { reorderByDrop } from "../src/tabs/reorder";
import { TabBar } from "../src/tabs/TabBar";
import type { TabActions } from "../src/tabs/tab-actions";
import { createFakeApi } from "./fake-api";

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
  const tabs = {
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
  } satisfies TabActions;
  const { api } = createFakeApi();
  render(<TabBar store={store} tabs={tabs} api={api} />);
  return { store, tabs, api };
}

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
