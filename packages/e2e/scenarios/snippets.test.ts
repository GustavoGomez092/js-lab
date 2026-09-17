// biome-ignore-all lint/suspicious/noTemplateCurlyInString: `${1:url}` in a plain string is Monaco snippet syntax --
// the tab-stop body this scenario seeds and then expects Monaco to expand -- never an interpolation that lost its
// backtick. Same suppression, same reason, as `apps/ui/test/snippet-text.test.ts` and its siblings.
import { afterEach, describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { activeTab, createUserData, type E2EState, type LaunchedApp, launchApp, waitFor } from "../src";

let apps: LaunchedApp[] = [];
afterEach(async () => {
  for (const app of apps.reverse()) await app.dispose();
  apps = [];
});

const AT = "2026-09-16T10:00:00.000Z";
/** Named rather than reached through `LIBRARY.snippets[0]`, which `noUncheckedIndexedAccess` types as optional. */
const FETCHJSON = {
  id: "s1",
  name: "fetchjson",
  description: "Fetch + parse JSON",
  body: "const res = await fetch(${1:url});$0",
  language: "typescript",
  createdAt: AT,
  updatedAt: AT,
};
const LIBRARY = { format: "jslab-snippets", version: 1, snippets: [FETCHJSON] };

type Regions = Record<string, boolean>;
const regions = (state: E2EState) => state.ui.regions as Regions;
const snippetsFile = (app: LaunchedApp) => join(app.userData, "snippets.json");

/**
 * The library is seeded on disk rather than typed through the form: it makes the scenario about the behaviours that
 * matter (expansion, export, a refused import, persistence) instead of about form typing, and it is the same
 * technique `keybindings.test.ts` already uses for `keybindings.json`. `snippets.json` in the data folder is what
 * `SnippetStore` reads -- `apps/desktop/src/main/app-paths.ts`'s `snippetsFile` entry.
 */
async function seeded() {
  const userData = await createUserData();
  await writeFile(join(userData, "snippets.json"), JSON.stringify(LIBRARY));
  const app = await launchApp({ userData });
  apps.push(app);
  return app;
}

/**
 * Mounts the snippets panel and waits until the stored library has reached the UI store.
 *
 * This is not ceremony. `SnippetsPanel`'s mount effect is the ONLY caller of `snippets.list` in the whole app -- no
 * startup path loads the library -- so until that panel has been on screen once, `state.snippets` is empty. And an
 * empty store is not an inert starting point: `snippets.expand` matches the trigger word against it, `snippets.export`
 * sends it as the file to write, and the import handler counts name collisions against it. A scenario that skips this
 * would not fail honestly; it would pass for the wrong reason, or export an empty library and blame the format.
 *
 * `view.toggleSideBar` is used rather than ⌘B because `tools.snippets` also fires `requestSnippets("focusSearch")`,
 * which moves DOM focus into the panel's search box -- and the resolver drops modifier-less chords while a text input
 * has focus, so the bare Tab the expansion tests are about would never reach a command. The side bar's default panel
 * is already "snippets" (`store.ts`), so this mounts the panel without touching focus.
 */
async function withLibrary(app: LaunchedApp, expected: number) {
  await app.command("view.toggleSideBar");
  await waitFor(async () => ((await app.state()).ui.snippetCount === expected ? true : null), {
    timeoutMs: 15_000,
    message: `the snippet library never reached the UI (expected ${expected})`,
  });
}

describe("snippets (spec §13)", () => {
  test("⌘B shows the panel with the stored library, and ⌘B again hides it (TL-12, TL-13)", async () => {
    const app = await seeded();
    await app.key("cmd+b");
    const opened = await waitFor(
      async () => {
        const state = await app.state();
        return regions(state).snippetsPanel ? state : null;
      },
      { message: "⌘B never put the snippets panel on screen" },
    );
    expect(opened.ui.settings?.view.sideBar).toBe(true);
    expect(opened.ui.sideBarPanel).toBe("snippets");

    // The seeded file really is the library the app reads: it came back over `snippets.list` from `SnippetStore`.
    const loaded = await waitFor(
      async () => {
        const state = await app.state();
        return state.ui.snippetCount === 1 ? state : null;
      },
      { timeoutMs: 15_000, message: "the seeded library never reached the UI" },
    );
    expect(loaded.ui.snippetCount).toBe(1);

    // Three-way, not "always open": a second ⌘B while the snippets panel is showing hides the side bar.
    await app.key("cmd+b");
    await waitFor(async () => ((await app.state()).ui.settings?.view.sideBar === false ? true : null), {
      message: "⌘B a second time never hid the side bar",
    });
  });

  /**
   * M5a's panel and M5b's share one side bar and one `sideBarPanel`, and neither branch of `SideBar.tsx` is enforced
   * by the type system (ruling R-M5b-D3/D4-FIX). This is the end-to-end half of that guard: in a real built app, each
   * command must land on its OWN panel, not on the other one and not on the AI Chat placeholder.
   */
  test("Show Transpiled Output and ⌘B each open their own panel, not each other's (spec §7.4, §13.1)", async () => {
    const app = await seeded();
    await app.command("view.showTranspiled");
    const transpiled = await waitFor(
      async () => {
        const state = await app.state();
        return regions(state).transpiledPanel ? state : null;
      },
      { message: "Show Transpiled Output never put the transpiled panel on screen" },
    );
    expect([transpiled.ui.sideBarPanel, regions(transpiled).snippetsPanel]).toEqual(["transpiled", false]);

    // ⌘B from the transpiled panel SWITCHES rather than closing, and the side bar stays open throughout.
    await app.key("cmd+b");
    const snippets = await waitFor(
      async () => {
        const state = await app.state();
        return regions(state).snippetsPanel ? state : null;
      },
      { message: "⌘B never switched the side bar to the snippets panel" },
    );
    expect([snippets.ui.sideBarPanel, regions(snippets).transpiledPanel]).toEqual(["snippets", false]);
    expect(snippets.ui.settings?.view.sideBar).toBe(true);
  });

  test("typing a snippet name and pressing Tab expands it with the cursor placeholder (TL-15, TL-16)", async () => {
    const app = await seeded();
    await withLibrary(app, 1);
    await app.type("fetchjson", true);
    // JSLab consumed the keystroke, which is the half that says the command fired at all.
    const pressed = await app.key("tab");
    expect(pressed.defaultPrevented).toBe(true);
    const expanded = await waitFor(
      async () => {
        const state = await app.state();
        return activeTab(state).code.startsWith("const res = await fetch(") ? state : null;
      },
      { timeoutMs: 15_000, message: "Tab never expanded the snippet" },
    );
    // The trigger word itself is gone, and the placeholder's default text is in the buffer -- so this really went in
    // through Monaco's snippet controller as a TEMPLATE, not as the literal body with `${1:url}` still in it.
    const code = activeTab(expanded).code;
    expect(code).not.toContain("fetchjson");
    expect(code).toContain("url");
    expect(code).not.toContain("${1:");
  });

  /**
   * The safety argument for binding a bare Tab, measured rather than assumed: with no snippet name before the caret
   * the command reports isEnabled() === false, App.tsx returns before preventDefault, and the keystroke is left
   * alone. Asserting `defaultPrevented` pins exactly that, without depending on what Monaco then does with a
   * synthetic key -- which it does not do at all (a constructed KeyboardEvent carries no legacy `keyCode`, and
   * Monaco's keybinding dispatch reads that), so the plan's "the buffer changed" would have failed as a timeout.
   *
   * `withLibrary` is what keeps this from passing for the wrong reason: with an EMPTY store no word expands, so the
   * assertion would hold even against a mutant that matched every word. Here "fetchjson" genuinely would expand --
   * the test above proves it in this very same state -- and "x" genuinely does not.
   */
  test("Tab with no snippet name in front of the caret is not consumed (ruling R-M5b-7)", async () => {
    const app = await seeded();
    await withLibrary(app, 1);
    await app.type("x", true);
    const pressed = await app.key("tab");
    expect(pressed.defaultPrevented).toBe(false);
    // And nothing was expanded: the snippet body never entered the buffer.
    const state = await app.state();
    expect(activeTab(state).code).not.toContain("await fetch");
    expect(activeTab(state).code.startsWith("x")).toBe(true);
  });

  test("Export writes the documented format (TL-17)", async () => {
    const app = await seeded();
    await withLibrary(app, 1);
    const target = join(app.userData, "exported.json");
    await writeFile(join(app.userData, "e2e-save-dialog.json"), JSON.stringify({ path: target }));
    await app.command("snippets.export");
    const written = await waitFor(
      async () => {
        try {
          return JSON.parse(await readFile(target, "utf8")) as {
            format: string;
            version: number;
            snippets: { name: string; body: string }[];
          };
        } catch {
          return null;
        }
      },
      { timeoutMs: 15_000, message: "the export never produced a file" },
    );
    expect([written.format, written.version, written.snippets.length]).toEqual(["jslab-snippets", 1, 1]);
    expect(written.snippets[0]?.name).toBe("fetchjson");
    // The body round-trips byte for byte: an export that rendered its tab stops away would still satisfy a name check.
    expect(written.snippets[0]?.body).toBe(FETCHJSON.body);
  });

  /**
   * CORRECTED from the plan, which imported the app's own export and called it "a no-conflict merge ... still one".
   * It is not: the incoming name collides with the stored one, so the panel raises the overwrite / keep both / skip
   * chooser and applies NOTHING until the user answers. The plan's assertion (`snippetCount === 1`) never exercised a
   * merge at all. What is worth asserting is that a pending conflict changes neither the store nor the file, which is
   * also the claim ruling R-M5b-8 makes -- and the wait is on the chooser appearing, because `snippetCount` and
   * `snippets.json` are already at their expected values before the import is dispatched, so waiting on those would
   * assert nothing about whether the import ever ran.
   */
  test("importing a library whose names all collide changes nothing until the user chooses (R-M5b-8)", async () => {
    const app = await seeded();
    await withLibrary(app, 1);
    const target = join(app.userData, "exported.json");
    await writeFile(join(app.userData, "e2e-save-dialog.json"), JSON.stringify({ path: target }));
    await app.command("snippets.export");
    await waitFor(
      async () => {
        try {
          return (await readFile(target, "utf8")).length > 0 ? true : null;
        } catch {
          return null;
        }
      },
      { timeoutMs: 15_000, message: "the export never produced a file" },
    );
    const before = await readFile(snippetsFile(app), "utf8");

    await writeFile(join(app.userData, "e2e-open-dialog.json"), JSON.stringify([target]));
    await app.command("snippets.import");
    await waitFor(async () => (regions(await app.state()).snippetsConflicts ? true : null), {
      timeoutMs: 15_000,
      message: "the import never raised the overwrite / keep both / skip chooser",
    });
    expect((await app.state()).ui.snippetCount).toBe(1);
    // Byte-identical: a pending conflict must not have written the library. A merge that ran anyway would rewrite
    // this file through `snippetsFileContent`, which is indented and newline-terminated, so even a no-op merge shows.
    expect(await readFile(snippetsFile(app), "utf8")).toBe(before);
  });

  test("a malformed snippets file is refused and the library survives (spec §13.4)", async () => {
    const app = await seeded();
    await withLibrary(app, 1);
    const before = await readFile(snippetsFile(app), "utf8");
    const bad = join(app.userData, "not-a-library.json");
    // A well-formed JSON document that is not a JSLab library: `parseSnippetsFile` refuses it on `format`.
    await writeFile(bad, '{ "format": "vscode-snippets", "version": 1, "snippets": [] }');
    await writeFile(join(app.userData, "e2e-open-dialog.json"), JSON.stringify([bad]));
    await app.command("snippets.import");
    // The refusal reached the panel, so what follows is measured after the round trip rather than before it.
    await waitFor(async () => (regions(await app.state()).snippetsError ? true : null), {
      timeoutMs: 15_000,
      message: "the refused import never reported itself",
    });
    expect((await app.state()).ui.snippetCount).toBe(1);
    expect(await readFile(snippetsFile(app), "utf8")).toBe(before);
    // The chooser is for conflicts, not for refusals: a refused file must never offer to merge itself.
    expect(regions(await app.state()).snippetsConflicts).toBe(false);
  });

  test("an imported snippet with a new name merges and survives a relaunch (TL-17)", async () => {
    const app = await seeded();
    await withLibrary(app, 1);
    const extra = join(app.userData, "extra.json");
    await writeFile(
      extra,
      JSON.stringify({ ...LIBRARY, snippets: [{ ...FETCHJSON, id: "s2", name: "brandnew", body: "console.log($0)" }] }),
    );
    await writeFile(join(app.userData, "e2e-open-dialog.json"), JSON.stringify([extra]));
    await app.command("snippets.import");
    // No conflict, so this one applies with no chooser: the merge path actually merges.
    await waitFor(async () => ((await app.state()).ui.snippetCount === 2 ? true : null), {
      timeoutMs: 15_000,
      message: "the non-colliding import never merged",
    });
    const merged = JSON.parse(await readFile(snippetsFile(app), "utf8")) as { snippets: { name: string }[] };
    expect(merged.snippets.map((snippet) => snippet.name).sort()).toEqual(["brandnew", "fetchjson"]);

    // Quit before relaunching into the same data folder -- the idiom `tabs.test.ts` and `logpoints.test.ts` use.
    // Two live apps would share one `jslab.sock`, and the second client would simply reconnect to the first app.
    await app.quit();
    const again = await launchApp({ userData: app.userData });
    apps.push(again);
    await withLibrary(again, 2);
    expect((await again.state()).ui.snippetCount).toBe(2);
  });
});
