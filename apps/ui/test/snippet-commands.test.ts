// biome-ignore-all lint/suspicious/noTemplateCurlyInString: `${1:url}` in a plain string is Monaco snippet syntax --
// the tab-stop body these commands must pass through UNESCAPED -- never an interpolation that lost its backtick.
// Same suppression, same reason, as the sibling `apps/ui/test/snippet-text.test.ts`.
import { describe, expect, mock, test } from "bun:test";
import { createTab, defaultSession, defaultSettings, mergeSettings, type Snippet } from "@jslab/shared";
import type { EditorHandle } from "../src/editor/editor-handle";
import { createSnippetActions, createSnippetCommands } from "../src/snippets/snippet-actions";
import { createAppStore } from "../src/state/store";
import { createFakeApi } from "./fake-api";

const AT = "2026-09-16T10:00:00.000Z";
const snippet = (name: string, body: string, language: Snippet["language"] = null): Snippet => ({
  id: name,
  name,
  description: "",
  body,
  language,
  createdAt: AT,
  updatedAt: AT,
});

function setup(
  options: { before?: string; sideBar?: boolean; panel?: "snippets" | "ai" | "transpiled"; canSnippet?: boolean } = {},
) {
  const store = createAppStore();
  store.getState().hydrate({
    settings: mergeSettings(defaultSettings(), { view: { sideBar: options.sideBar ?? false } }),
    session: defaultSession(() => createTab({ id: "t1" })),
    buffers: { t1: "" },
    safeMode: { active: false, reason: null },
    versions: { app: "0", bun: "1.4.0" },
  });
  if (options.panel) store.getState().setSideBarPanel(options.panel);
  // Deliberately NOT in name order, and the exact-match fixture is not first: a fixture written in the order the
  // code happens to produce disarms every ordering and selection assertion made against it.
  store
    .getState()
    .receiveSnippets([
      snippet("plain", "cost: $5"),
      snippet("fetchjson", "await fetch(${1:url})$0"),
      snippet("jsx", "<div />", "tsx"),
    ]);
  const { api } = createFakeApi();
  const editor = {
    textBeforeCursor: mock(() => options.before ?? ""),
    insertSnippet: mock((_template: string, _deleteBefore?: number) => options.canSnippet ?? true),
    selectedTextOrAll: mock(() => "const selected = 1"),
    typeText: mock((_text: string, _replace: boolean) => {}),
  } as unknown as EditorHandle & Record<string, ReturnType<typeof mock>>;
  const tabs = { newTab: mock(async () => {}) };
  const panel = {
    showing: options.sideBar === true && (options.panel ?? "snippets") === "snippets",
    opened: 0,
    closed: 0,
  };
  const actionDeps = { store, editor: () => editor, tabs };
  const commandDeps = {
    ...actionDeps,
    api,
    panelShowing: () => panel.showing,
    openPanel: () => {
      panel.opened += 1;
      panel.showing = true;
    },
    closePanel: () => {
      panel.closed += 1;
      panel.showing = false;
    },
  };
  const actions = createSnippetActions(actionDeps);
  const commands = new Map(createSnippetCommands(commandDeps).map((spec) => [spec.id, spec]));
  return { store, api, editor, tabs, panel, actions, commands, commandDeps };
}

describe("snippet actions (spec §13.1)", () => {
  test("Insert sends the template, escaping $ in a body with no placeholders (§13.2)", () => {
    const { actions, editor, store } = setup();
    const withStops = store.getState().snippets.find((s) => s.name === "fetchjson");
    const plain = store.getState().snippets.find((s) => s.name === "plain");
    if (!withStops || !plain) throw new Error("fixture");
    actions.insert(withStops);
    expect(editor.insertSnippet).toHaveBeenCalledWith("await fetch(${1:url})$0", 0);
    // BOTH directions matter (ruling R-M5b-D1): a literal `$5` must survive, and a real tab stop must not be escaped.
    actions.insert(plain);
    expect(editor.insertSnippet).toHaveBeenLastCalledWith("cost: \\$5", 0);
  });

  test("Insert falls back to typing when this Monaco build has no snippet controller", () => {
    const { actions, editor, store } = setup({ canSnippet: false });
    const withStops = store.getState().snippets.find((s) => s.name === "fetchjson");
    if (!withStops) throw new Error("fixture");
    actions.insert(withStops);
    // The literal rendering: the placeholder leaves its default text, the exit stop vanishes.
    expect(editor.typeText).toHaveBeenCalledWith("await fetch(url)", false);
  });

  test("Insert in New Tab opens a tab with the plain text and the snippet's language", async () => {
    const { actions, tabs, store } = setup();
    const jsx = store.getState().snippets.find((s) => s.name === "jsx");
    if (!jsx) throw new Error("fixture");
    await actions.insertInNewTab(jsx);
    expect(tabs.newTab).toHaveBeenCalledWith({ content: "<div />", language: "tsx" });
  });

  test("a language-less snippet opens a tab with no language override, not `language: null`", async () => {
    const { actions, tabs, store } = setup();
    const plain = store.getState().snippets.find((s) => s.name === "plain");
    if (!plain) throw new Error("fixture");
    await actions.insertInNewTab(plain);
    expect(tabs.newTab).toHaveBeenCalledWith({ content: "cost: $5" });
  });

  /**
   * Insert in New Tab must NOT route through the snippet controller: a fresh buffer has nowhere to put tab stops.
   * Without this, an implementation that reused `put()` for the new tab would pass every other test here.
   */
  test("Insert in New Tab never touches the editor", async () => {
    const { actions, editor, store } = setup();
    const jsx = store.getState().snippets.find((s) => s.name === "jsx");
    if (!jsx) throw new Error("fixture");
    await actions.insertInNewTab(jsx);
    expect(editor.insertSnippet).not.toHaveBeenCalled();
    expect(editor.typeText).not.toHaveBeenCalled();
  });

  test("with no editor mounted, Insert is a no-op rather than a crash", () => {
    const { commandDeps, tabs } = setup();
    const actions = createSnippetActions({ ...commandDeps, editor: () => null });
    expect(() => actions.insert(snippet("plain", "cost: $5"))).not.toThrow();
    expect(actions.selectionForNewSnippet()).toBeNull();
    expect(actions.canExpandAtCursor()).toBe(false);
    expect(actions.expandAtCursor()).toBe(false);
    expect(tabs.newTab).not.toHaveBeenCalled();
  });
});

describe("snippet commands (spec §6.5, ruling R-M5b-3)", () => {
  test("⌘B opens the panel and focuses search; pressing it again hides the side bar", () => {
    const hidden = setup({ sideBar: false });
    hidden.commands.get("tools.snippets")?.run();
    expect(hidden.panel.opened).toBe(1);
    expect(hidden.store.getState().snippetsRequest).toMatchObject({ kind: "focusSearch" });

    const showing = setup({ sideBar: true, panel: "snippets" });
    showing.commands.get("tools.snippets")?.run();
    expect([showing.panel.closed, showing.panel.opened]).toEqual([1, 0]);
    expect(showing.store.getState().snippetsRequest).toBeNull();
  });

  test("⌘B on another panel switches to Snippets rather than closing the side bar", () => {
    // "transpiled" specifically, not "ai": M5a's panel is the one a snippets-only reading of the side bar forgets.
    for (const panel of ["ai", "transpiled"] as const) {
      const { commands, panel: spy, store } = setup({ sideBar: true, panel });
      commands.get("tools.snippets")?.run();
      expect([panel, spy.opened, spy.closed]).toEqual([panel, 1, 0]);
      expect(store.getState().snippetsRequest).toMatchObject({ kind: "focusSearch" });
    }
  });

  test("Create Snippet… opens the panel with the selection as the body (§13.1)", () => {
    const { commands, store, panel } = setup();
    commands.get("snippets.create")?.run();
    expect(panel.opened).toBe(1);
    expect(store.getState().snippetsRequest).toMatchObject({ kind: "newSnippet", body: "const selected = 1" });
  });

  test("a repeated request still reaches the panel, because the nonce moves", () => {
    const { commands, store } = setup();
    commands.get("snippets.create")?.run();
    const first = store.getState().snippetsRequest;
    store.getState().clearSnippetsRequest();
    commands.get("snippets.create")?.run();
    const second = store.getState().snippetsRequest;
    expect([first?.body, second?.body]).toEqual(["const selected = 1", "const selected = 1"]);
    expect(second?.nonce).toBeGreaterThan(first?.nonce ?? 0);
  });

  test("Import and Export open the panel first, so its answer can't arrive unheard", () => {
    const { commands, api, panel, store } = setup();
    commands.get("snippets.import")?.run();
    expect([panel.opened, api.snippetsImportDialog.mock.calls.length]).toEqual([1, 1]);
    commands.get("snippets.export")?.run();
    expect([panel.opened, api.snippetsExportDialog.mock.calls.length]).toEqual([2, 1]);
    expect(api.snippetsExportDialog).toHaveBeenLastCalledWith(store.getState().snippets);
  });

  test("Tab expands an exact trigger word and deletes what was typed", () => {
    const { commands, editor } = setup({ before: "const x = fetchjson" });
    expect(commands.get("snippets.expand")?.isEnabled?.()).toBe(true);
    commands.get("snippets.expand")?.run();
    expect(editor.insertSnippet).toHaveBeenCalledWith("await fetch(${1:url})$0", 9);
  });

  test("the match is case-insensitive on BOTH sides, stored and typed", () => {
    const upper = setup({ before: "FETCHJSON" });
    expect(upper.commands.get("snippets.expand")?.isEnabled?.()).toBe(true);
    upper.commands.get("snippets.expand")?.run();
    expect(upper.editor.insertSnippet).toHaveBeenCalledWith("await fetch(${1:url})$0", 9);
  });

  test("Tab is disabled with no trigger word, so the keystroke reaches Monaco untouched", () => {
    for (const before of ["", "fetchjs", "const x = ", "nothing", "obj."]) {
      const { commands, editor } = setup({ before });
      expect([before, commands.get("snippets.expand")?.isEnabled?.()]).toEqual([before, false]);
      commands.get("snippets.expand")?.run();
      expect(editor.insertSnippet).not.toHaveBeenCalled();
      expect(editor.typeText).not.toHaveBeenCalled();
    }
  });

  /**
   * Tab expansion of a body with no tab stops must still ESCAPE its `$`, exactly as Insert does. Without this, an
   * implementation whose expansion path skipped `snippetTemplate` would pass every Insert test above.
   */
  test("Tab expansion escapes a literal $ in the expanded body too", () => {
    const { commands, editor } = setup({ before: "plain" });
    expect(commands.get("snippets.expand")?.isEnabled?.()).toBe(true);
    commands.get("snippets.expand")?.run();
    expect(editor.insertSnippet).toHaveBeenCalledWith("cost: \\$5", 5);
  });

  test("every snippet command is disabled when no editor is mounted, except the panel ones", () => {
    const { commandDeps } = setup();
    const withoutEditor = createSnippetCommands({ ...commandDeps, editor: () => null });
    const byId = new Map(withoutEditor.map((spec) => [spec.id, spec]));
    expect(byId.get("snippets.expand")?.isEnabled?.()).toBe(false);
    expect(byId.get("snippets.create")?.isEnabled?.()).toBe(false);
    expect(byId.get("tools.snippets")?.isEnabled?.() ?? true).toBe(true);
    expect(byId.get("snippets.import")?.isEnabled?.() ?? true).toBe(true);
    expect(byId.get("snippets.export")?.isEnabled?.() ?? true).toBe(true);
  });

  /** The five ids are the contract Task 11's e2e and `menu.ts` both dispatch; a renamed id must fail here. */
  test("exactly the five snippet commands are created", () => {
    const { commands } = setup();
    expect([...commands.keys()].sort()).toEqual([
      "snippets.create",
      "snippets.expand",
      "snippets.export",
      "snippets.import",
      "tools.snippets",
    ]);
  });
});
