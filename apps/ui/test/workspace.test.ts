import { describe, expect, test } from "bun:test";
import { clampEditorSize, gotoTabIndex, insertAfterActive, isPermutation, renamePatch } from "../src/state/workspace";

describe("workspace helpers", () => {
  test("new tabs go after the active tab; reorders must be permutations", () => {
    expect(insertAfterActive(["a", "b", "c"], "a", "n")).toEqual(["a", "n", "b", "c"]);
    expect(insertAfterActive(["a"], null, "n")).toEqual(["a", "n"]);
    expect(insertAfterActive(["a", "n"], "a", "n")).toEqual(["a", "n"]);
    expect(isPermutation(["a", "b"], ["b", "a"])).toBe(true);
    expect(isPermutation(["a", "b"], ["a", "a"])).toBe(false);
    expect(isPermutation(["a", "b"], ["a"])).toBe(false);
  });

  test("renaming trims to 200 characters and an empty name restores the derived title", () => {
    expect(renamePatch("  fetch users  ")).toEqual({ title: "fetch users", titleIsCustom: true });
    expect(renamePatch("   ")).toEqual({ title: "Untitled", titleIsCustom: false });
    expect(renamePatch("x".repeat(300)).title).toHaveLength(200);
  });

  test("Cmd+1–8 pick a tab by position, Cmd+9 picks the last tab, and sizes clamp to 10–90", () => {
    const order = ["a", "b", "c"];
    expect([gotoTabIndex(order, 1), gotoTabIndex(order, 3), gotoTabIndex(order, 4), gotoTabIndex(order, 9)]).toEqual([
      "a",
      "c",
      null,
      "c",
    ]);
    expect([clampEditorSize(5), clampEditorSize(50), clampEditorSize(95)]).toEqual([10, 50, 90]);
  });
});
