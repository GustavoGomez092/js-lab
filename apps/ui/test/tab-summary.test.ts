import { describe, expect, test } from "bun:test";
import { createTabSummaryCache } from "../src/tabs/tab-summary";

function tab(
  id: string,
  overrides: Partial<{
    title: string;
    titleIsCustom: boolean;
    filePath: string | null;
    lastSavedHash: string | null;
  }> = {},
) {
  return { id, title: "Untitled", titleIsCustom: false, filePath: null, lastSavedHash: null, ...overrides };
}

describe("createTabSummaryCache (RR2-m1)", () => {
  test("retain releases entries for tabs no longer in the given set", () => {
    const cache = createTabSummaryCache({ title: (_t, code) => code, dirty: () => false });
    cache.title(tab("a"), "code a");
    cache.title(tab("b"), "code b");
    expect(cache.size()).toBe(2);
    cache.retain(new Set(["b"]));
    expect(cache.size()).toBe(1);
    // The retained tab's entry is untouched and doesn't need recomputation for the same code.
    let computed = 0;
    const counting = createTabSummaryCache({
      title: (_t, code) => {
        computed++;
        return code;
      },
      dirty: () => false,
    });
    counting.title(tab("b"), "code b");
    counting.retain(new Set(["b"]));
    counting.title(tab("b"), "code b");
    expect(computed).toBe(1);
  });

  test("a single-entry active-tab cache never grows past one tab (App.tsx's toolbar-title usage, RR2-m1)", () => {
    const cache = createTabSummaryCache({ title: (_t, code) => code, dirty: () => false });
    // Mirrors App.tsx: retain to just the active tab whenever the active tab id changes.
    for (const id of ["t1", "t2", "t3"]) {
      cache.title(tab(id), `code for ${id}`);
      cache.retain(new Set([id]));
      expect(cache.size()).toBe(1);
    }
  });
});
