import { describe, expect, test } from "bun:test";
import { tabPatchSchema } from "@jslab/rpc-schema";
import { createTab, type TabState } from "@jslab/shared";
import { computeTabPatch } from "../src/shell/tab-patch";
import { createAppStore } from "../src/state/store";

/**
 * M5c F3. `jslab --title renamed-by-cli a.ts` on an ALREADY-OPEN file renames the tab in Main (open-service.ts,
 * R-M5c-TITLE-1), but the `file.opened` push for an already-open file carries no entry for it, so the UI's store
 * never learned the rename -- and `computeTabPatch` returned `title`/`titleIsCustom` on EVERY tracked change.
 * One unrelated divider drag therefore pushed the stale title back and Main silently REVERTED the rename.
 * Nothing covered this: there was no tab-patch test at all, and the two `computeTabPatch` cases in
 * output-tiles.test.tsx assert only `layout`.
 */

const openedInMain = createTab({ id: "t1", filePath: "/w/a.ts", title: "a.ts", titleIsCustom: false });
/** Main's tab immediately after the CLI rename. */
const renamedInMain: TabState = { ...openedInMain, title: "renamed-by-cli", titleIsCustom: true };

/** Main's own merge (`SessionStore.patchTab`: `{ ...tab, ...patch }`), through the real wire schema. */
function applyToMain(main: TabState, patch: ReturnType<typeof computeTabPatch>): TabState {
  if (!patch) return main;
  const parsed = tabPatchSchema.parse({ tabId: main.id, patch });
  return { ...main, ...parsed.patch } as TabState;
}

const dragDivider = (tab: TabState): TabState => ({ ...tab, layout: { ...tab.layout, editorSize: 42 } });

describe("the tab.patch the UI sends after a CLI rename", () => {
  test("an unrelated divider drag cannot revert a title the UI's store has not learned (M5c F3)", () => {
    // The exact pre-fix reproduction: the UI still holds the OLD title and the user drags the divider.
    const patch = computeTabPatch(openedInMain, dragDivider(openedInMain));
    expect(patch).not.toBeNull();
    // Before the fix this patch carried {"title":"a.ts","titleIsCustom":false}.
    expect(patch).not.toHaveProperty("title");
    expect(patch).not.toHaveProperty("titleIsCustom");
    const main = applyToMain(renamedInMain, patch);
    expect([main.title, main.titleIsCustom]).toEqual(["renamed-by-cli", true]);
    // ...and the drag the user actually made still got through.
    expect(main.layout.editorSize).toBe(42);
  });

  test("the tab.updated push puts the CLI's rename in the UI's store, so the tab bar shows it", () => {
    const store = createAppStore();
    store.getState().openTab(openedInMain, "const a = 1");
    expect(store.getState().tabs.t1?.title).toBe("a.ts");
    // App.tsx's `tab.updated` handler -- the same store action `wd.changed` and `file.saved` already use.
    store.getState().applyTabUpdate(renamedInMain);
    const learned = store.getState().tabs.t1 as TabState;
    expect([learned.title, learned.titleIsCustom]).toEqual(["renamed-by-cli", true]);
    // A later drag now agrees with Main either way.
    expect(applyToMain(renamedInMain, computeTabPatch(learned, dragDivider(learned))).title).toBe("renamed-by-cli");
  });

  test("with no user edit there is no patch at all, so the rename survives (control)", () => {
    expect(computeTabPatch(renamedInMain, renamedInMain)).toBeNull();
  });

  test("a rename the user actually makes still reaches Main", () => {
    const renamedByUser: TabState = { ...renamedInMain, title: "mine", titleIsCustom: true };
    const patch = computeTabPatch(renamedInMain, renamedByUser);
    expect(patch).toMatchObject({ title: "mine", titleIsCustom: true });
    expect(applyToMain(renamedInMain, patch).title).toBe("mine");
  });
});
