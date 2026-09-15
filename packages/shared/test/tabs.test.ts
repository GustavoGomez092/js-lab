import { describe, expect, spyOn, test } from "bun:test";
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
  scriptFileName,
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

  // FB-I2: the title scan stops at the first non-blank line instead of splitting the whole buffer into lines, with
  // results identical to the split-based definition.
  test("the derived title matches the split-based definition and never splits the buffer (FB-I2)", () => {
    const base = { title: "x", titleIsCustom: false, filePath: null };
    const reference = (code: string) => {
      const first = code
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.length > 0);
      if (!first) return "Untitled";
      return first.length > 30 ? `${first.slice(0, 29).trimEnd()}…` : first;
    };
    const alphabet = [" ", "\t", "\n", "\r", "\r\n", "a", "b", "é", " ", " ", "; ", "x".repeat(12)];
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const cases = [
      "",
      "\n",
      "a",
      " \r\n\t x \r\n",
      `${"a".repeat(30)}`,
      `${"a".repeat(30)}   `,
      `${"a".repeat(31)}`,
      `${"a".repeat(28)} b`,
      `${"a".repeat(29)} b`,
      `${"a".repeat(28)}  b`,
      `  ${"a".repeat(30)} \n b`,
      `${"a".repeat(30)} b`,
    ];
    for (let index = 0; index < 3000; index++) {
      const length = Math.floor(random() * 24);
      cases.push(Array.from({ length }, () => alphabet[Math.floor(random() * alphabet.length)]).join(""));
    }
    for (const code of cases) expect([code, deriveTitle(base, code)]).toEqual([code, reference(code)]);

    const split = spyOn(String.prototype, "split");
    try {
      deriveTitle(base, `\n\nconst first = 1\n${"line\n".repeat(1000)}`);
      expect(split).not.toHaveBeenCalled();
    } finally {
      split.mockRestore();
    }
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

test("scriptFileName names __filename from the file, or from the title with the language extension (spec §5.3)", () => {
  expect(scriptFileName(createTab({ filePath: "/p/api/client.mts", language: "typescript" }), "")).toBe("client.mts");
  expect(scriptFileName(createTab({ title: "fetch users", titleIsCustom: true, language: "tsx" }), "")).toBe(
    "fetch users.tsx",
  );
  expect(
    scriptFileName(
      createTab({ language: "javascript" }),
      `// a/b:c${String.fromCharCode(92)}d${String.fromCharCode(10)}`,
    ),
  ).toBe("-- a-b-c-d.js");
  expect(scriptFileName(createTab({ language: "typescript" }), "")).toBe("Untitled.ts");
  expect(scriptFileName(createTab({ title: ".ts", titleIsCustom: true, language: "typescript" }), "")).toBe(
    "Untitled.ts",
  );
});
