import { describe, expect, test } from "bun:test";
import { createTab } from "../src/session";
import {
  adjacentTabId,
  contentHash,
  deriveTitle,
  extensionFor,
  isDirty,
  languageForPath,
  moveTab,
  pushClosed,
  tabAfterClose,
} from "../src/tabs";

describe("tab helpers", () => {
  test("language follows the file extension (spec §10.2)", () => {
    expect(["a.ts", "a.mts", "A.CTS", "a.tsx", "a.jsx", "a.js", "a.mjs", "notes.txt"].map(languageForPath)).toEqual([
      "typescript",
      "typescript",
      "typescript",
      "tsx",
      "jsx",
      "javascript",
      "javascript",
      "javascript",
    ]);
    expect(extensionFor("tsx")).toBe("tsx");
  });

  test("titles: custom wins, then file name, then the first code line trimmed to 30, then Untitled", () => {
    const base = { title: "x", titleIsCustom: false, filePath: null };
    expect(deriveTitle({ ...base, title: "Mine", titleIsCustom: true, filePath: "/a/b.ts" }, "1")).toBe("Mine");
    expect(deriveTitle({ ...base, filePath: "/Users/me/fetch-users.ts" }, "1")).toBe("fetch-users.ts");
    expect(deriveTitle(base, "\n\n   const answer = 42   \nmore")).toBe("const answer = 42");
    expect(deriveTitle(base, "const aVeryLongVariableName = somethingElse()")).toBe("const aVeryLongVariableName =…");
    expect(deriveTitle(base, "const aVeryLongVariableName = somethingElse()")).toHaveLength(30);
    expect(deriveTitle(base, "  \n ")).toBe("Untitled");
  });

  test("content hashes are stable and only saved-file tabs get dirty", () => {
    expect(contentHash("abc")).toBe(contentHash("abc"));
    expect(contentHash("abc")).not.toBe(contentHash("abd"));
    expect(contentHash("")).toMatch(/^0-[0-9a-f]{8}$/);
    const saved = createTab({ id: "t", filePath: "/a.ts", lastSavedHash: contentHash("x") });
    expect(isDirty(saved, "x")).toBe(false);
    expect(isDirty(saved, "y")).toBe(true);
    expect(isDirty(createTab({ id: "s" }), "anything")).toBe(false);
  });

  test("the closed stack is newest first, deduplicated and capped at 20", () => {
    let stack = [] as ReturnType<typeof pushClosed>["stack"];
    const evicted: string[] = [];
    for (let i = 0; i < 22; i++) {
      const result = pushClosed(stack, { tab: createTab({ id: `t${i}` }), closedAt: i });
      stack = result.stack;
      evicted.push(...result.evicted.map((entry) => entry.tab.id));
    }
    expect(stack).toHaveLength(20);
    expect(stack[0]?.tab.id).toBe("t21");
    expect(evicted).toEqual(["t0", "t1"]);
    const again = pushClosed(stack, { tab: createTab({ id: "t5" }), closedAt: 99 });
    expect(again.stack.filter((entry) => entry.tab.id === "t5")).toHaveLength(1);
    expect(again.stack[0]?.tab.id).toBe("t5");
  });

  test("tab navigation wraps, and closing the active tab activates its right neighbor", () => {
    const order = ["a", "b", "c"];
    expect(adjacentTabId(order, "c", 1)).toBe("a");
    expect(adjacentTabId(order, "a", -1)).toBe("c");
    expect(adjacentTabId([], "a", 1)).toBeNull();
    expect(tabAfterClose(order, "b", "b")).toBe("c");
    expect(tabAfterClose(order, "c", "c")).toBe("b");
    expect(tabAfterClose(order, "a", "c")).toBe("c");
    expect(tabAfterClose(["a"], "a", "a")).toBeNull();
  });

  test("moveTab reorders by index and clamps out-of-range targets", () => {
    expect(moveTab(["a", "b", "c"], "a", 2)).toEqual(["b", "c", "a"]);
    expect(moveTab(["a", "b", "c"], "c", -5)).toEqual(["c", "a", "b"]);
    expect(moveTab(["a", "b"], "zz", 0)).toEqual(["a", "b"]);
  });
});
