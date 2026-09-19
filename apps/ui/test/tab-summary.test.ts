import { describe, expect, test } from "bun:test";
import { strings } from "../src/strings";
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

describe("createTabSummaryCache's real default (i18n, R-M5E-DT-1)", () => {
  /**
   * `TabBar` uses `createTabSummaryCache()` with no override, so its `title` compute is whatever the module
   * wires up by default. deriveTitle's own fallback parameter defaults to the English literal "Untitled" --
   * the caller is responsible for supplying the localized one (packages/shared/src/tabs.ts:37-41). This proves
   * the DEFAULT compute passed by tab-summary.ts routes through `strings.tabs.untitled` rather than deriveTitle's
   * hard-coded English default.
   */
  test("an empty, fileless, non-custom-titled tab's derived title is the current localized fallback", () => {
    const original = strings.tabs.untitled;
    (strings.tabs as { untitled: string }).untitled = "無題";
    try {
      const cache = createTabSummaryCache();
      expect(cache.title(tab("empty", { title: "" }), "")).toBe("無題");
    } finally {
      (strings.tabs as { untitled: string }).untitled = original;
    }
  });

  /**
   * The cache memoizes a tab's derived title per (code, title, titleIsCustom, filePath, lastSavedHash) -- none
   * of which mention the locale. `app.uiLanguage` is a restart-required setting (apps/ui/src/settings/fields.ts:48)
   * and the locale is resolved once, synchronously, from the URL at module load (apps/ui/src/i18n/index.ts) --
   * so within one cache's lifetime the fallback can never change; only a fresh page load (a fresh cache instance,
   * since TabBar creates one via `useState(createTabSummaryCache)`) can. This pins that a NEW cache picks up
   * whatever the fallback is AT THE TIME it computes, so no cache can be built holding a stale one.
   */
  test("a fresh cache reflects whichever localized fallback is current when it computes", () => {
    const original = strings.tabs.untitled;
    try {
      (strings.tabs as { untitled: string }).untitled = "Sin título";
      expect(createTabSummaryCache().title(tab("x1", { title: "" }), "")).toBe("Sin título");
      (strings.tabs as { untitled: string }).untitled = "無題";
      expect(createTabSummaryCache().title(tab("x2", { title: "" }), "")).toBe("無題");
    } finally {
      (strings.tabs as { untitled: string }).untitled = original;
    }
  });
});
