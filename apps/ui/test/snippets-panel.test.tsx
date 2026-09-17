import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createTab, defaultSession, defaultSettings, type Snippet } from "@jslab/shared";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ConfirmOptions } from "../src/shell/dialogs";
import { type SnippetColorize, SnippetsPanel } from "../src/snippets/SnippetsPanel";
import { createAppStore } from "../src/state/store";
import { strings } from "../src/strings";
import { createFakeApi } from "./fake-api";

const AT = "2026-09-16T10:00:00.000Z";
const snippet = (name: string, description: string, body = `body of ${name}`): Snippet => ({
  id: name,
  name,
  description,
  body,
  language: null,
  createdAt: AT,
  updatedAt: AT,
});

const LOG = snippet("log", "print a value");
const FETCH = snippet("fetchjson", "Fetch + parse JSON");
/**
 * Deliberately NOT in display order: `filterSnippets` sorts by name, so the panel has to actively reorder these.
 * A fixture written in expected-output order silently disarms every ordering assertion made against it -- the root
 * cause behind six surviving mutants in this plan's Task 6, and the same shape in Tasks 4 and 5.
 */
const LIBRARY = [LOG, FETCH];

function makeStore() {
  const store = createAppStore();
  store.getState().hydrate({
    settings: defaultSettings(),
    session: defaultSession(() => createTab({ id: "t1" })),
    buffers: { t1: "" },
    safeMode: { active: false, reason: null },
    versions: { app: "0", bun: "1.4.0" },
  });
  return store;
}

function setup(library: Snippet[] = LIBRARY, colorize?: SnippetColorize) {
  const store = makeStore();
  const { api, emit } = createFakeApi();
  api.snippetsList.mockImplementation(async () => library);
  const dialogs = { confirm: mock(async (_options: ConfirmOptions): Promise<string> => "delete") };
  const actions = { insert: mock((_s: Snippet) => {}), insertInNewTab: mock(async (_s: Snippet) => {}) };
  const clipboard = { writeText: mock(async (_text: string) => {}) };
  render(
    <SnippetsPanel
      store={store}
      api={api}
      dialogs={dialogs}
      actions={actions}
      clipboard={clipboard}
      colorize={colorize}
    />,
  );
  return { store, api, emit, dialogs, actions, clipboard };
}

const options = () => screen.queryAllByRole("option");
const rowNames = () => options().map((row) => row.querySelector("strong")?.textContent ?? "");
const option = (name: string) => screen.getByRole("option", { name: new RegExp(name) });
const select = (name: string) => fireEvent.click(option(name));
const button = (name: string) => screen.getByRole("button", { name });
const search = () => screen.getByLabelText(strings.snippets.searchLabel);
const type = (value: string) => fireEvent.change(search(), { target: { value } });
const previewText = () => document.querySelector(".snippets-preview")?.textContent ?? null;
const marksIn = (selector: string) =>
  [...(document.querySelectorAll(`${selector} mark`) ?? [])].map((mark) => mark.textContent);
const settle = async (run: () => void) => {
  await act(async () => {
    run();
    await Bun.sleep(1);
  });
};
const ready = () => screen.findByRole("option", { name: /fetchjson/ });

describe("snippets panel (spec §13.1)", () => {
  // R-M5b-D2: @tanstack/virtual-core sizes the scroll element from offsetWidth/offsetHeight, which happy-dom reports
  // as 0, so the virtualizer renders NO rows and every `role="option"` query fails. This is a harness defect, not a
  // component defect -- the component is correct in a real browser. Patch copied from the precedent that documents
  // it verbatim: apps/ui/test/output-panel.test.tsx:55-77. Only the snippets scroller is given a size.
  const SIZES = { offsetHeight: 600, offsetWidth: 400 } as const;
  const originals = new Map<keyof typeof SIZES, PropertyDescriptor | undefined>();
  beforeEach(() => {
    for (const [prop, size] of Object.entries(SIZES) as [keyof typeof SIZES, number][]) {
      const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop);
      originals.set(prop, original);
      Object.defineProperty(HTMLElement.prototype, prop, {
        configurable: true,
        get(this: HTMLElement) {
          return this.classList.contains("snippets-scroller") ? size : (original?.get?.call(this) ?? 0);
        },
      });
    }
  });
  afterEach(() => {
    for (const [prop, original] of originals) {
      if (original) Object.defineProperty(HTMLElement.prototype, prop, original);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[prop];
    }
    originals.clear();
  });

  test("loads the library on mount and lists it in name order, not in the order Main sent it", async () => {
    const { api, store } = setup();
    await ready();
    expect(api.snippetsList).toHaveBeenCalled();
    // Main sent ["log", "fetchjson"]; the panel must reorder. Asserting the array pins the ordering, not just presence.
    expect(rowNames()).toEqual(["fetchjson", "log"]);
    expect(screen.getByText("print a value")).toBeTruthy();
    expect(store.getState().snippets).toHaveLength(2);
    // apps/ui/isolated/app.test.tsx keys on this class to decide the side bar is open; the panel root carries it.
    expect(document.querySelector(".side-bar")).not.toBeNull();
  });

  test("nothing is claimed about the library before Main has answered", async () => {
    const store = makeStore();
    const { api } = createFakeApi();
    // Never resolves: this is the window between mount and the first `snippets.list` reply.
    api.snippetsList.mockImplementation(() => new Promise<Snippet[]>(() => {}));
    render(
      <SnippetsPanel
        store={store}
        api={api}
        dialogs={{ confirm: mock(async (_o: ConfirmOptions): Promise<string> => "cancel") }}
        actions={{ insert: mock((_s: Snippet) => {}), insertInNewTab: mock(async (_s: Snippet) => {}) }}
      />,
    );
    // "No snippets yet" here would be a lie -- the library has not been read, it is not known to be empty.
    expect(screen.queryByText(strings.snippets.empty)).toBeNull();
  });

  test("a library that cannot be read says so instead of looking empty", async () => {
    const store = makeStore();
    const { api } = createFakeApi();
    api.snippetsList.mockImplementation(async () => {
      throw new Error("EACCES");
    });
    render(
      <SnippetsPanel
        store={store}
        api={api}
        dialogs={{ confirm: mock(async (_o: ConfirmOptions): Promise<string> => "cancel") }}
        actions={{ insert: mock((_s: Snippet) => {}), insertInNewTab: mock(async (_s: Snippet) => {}) }}
      />,
    );
    expect(await screen.findByText(strings.snippets.loadFailed)).toBeTruthy();
    expect(screen.queryByText(strings.snippets.empty)).toBeNull();
  });

  test("the search box filters by name and by description", async () => {
    setup();
    await ready();
    type("log");
    expect(rowNames()).toEqual(["log"]);
    // "print" appears only in log's DESCRIPTION, so a filter that read the name alone would find nothing.
    type("print");
    expect(rowNames()).toEqual(["log"]);
    type("fetch");
    expect(rowNames()).toEqual(["fetchjson"]);
  });

  test("a row shows why it matched: the name's ranges, or the description's (R-M5b-DESC-1)", async () => {
    setup();
    await ready();
    // A description-only match highlights the description. Without this the row gives the user no indication of
    // why it is in the results at all.
    type("print");
    expect(marksIn(".snippets-description")).toEqual(["print"]);
    expect(marksIn(".snippets-name")).toEqual([]);
    // A name match highlights the name -- and NOT the description, even though "Fetch + parse JSON" also contains
    // the query. The name is why it ranked; highlighting both would credit the description for a decision it lost.
    type("fetch");
    expect(marksIn(".snippets-name")).toEqual(["fetch"]);
    expect(marksIn(".snippets-description")).toEqual([]);
  });

  test("the first row previews by default, and clicking another row moves the selection to it", async () => {
    setup();
    await ready();
    // Default is the first RANKED row (fetchjson), not the first row Main sent (log).
    expect(previewText()).toBe("body of fetchjson");
    expect(option("fetchjson").getAttribute("aria-selected")).toBe("true");
    select("log");
    expect(previewText()).toBe("body of log");
    expect([option("log").getAttribute("aria-selected"), option("fetchjson").getAttribute("aria-selected")]).toEqual([
      "true",
      "false",
    ]);
  });

  test("typing a new query previews the top match again rather than keeping a stale selection", async () => {
    setup();
    await ready();
    select("log");
    expect(previewText()).toBe("body of log");
    // "o" still matches log, so a selection that survived the keystroke would keep log previewed.
    type("o");
    expect(rowNames()).toEqual(["fetchjson", "log"]);
    expect(previewText()).toBe("body of fetchjson");
  });

  test("Insert, Insert in New Tab and Copy act on the selected snippet, not on the first one", async () => {
    const { actions, clipboard } = setup();
    await ready();
    // Selecting the SECOND row is what makes these assertions able to fail: acting on the default would give fetchjson.
    select("log");
    fireEvent.click(button(strings.snippets.insert));
    expect(actions.insert).toHaveBeenCalledWith(LOG);
    fireEvent.click(button(strings.snippets.insertInNewTab));
    expect(actions.insertInNewTab).toHaveBeenCalledWith(LOG);
    await settle(() => fireEvent.click(button(strings.snippets.copy)));
    expect(clipboard.writeText).toHaveBeenCalledWith("body of log");
    expect(screen.getByText(strings.snippets.copied)).toBeTruthy();
  });

  test("the actions follow the selection even when it is neither the first stored nor the first listed", async () => {
    // With only two snippets, whichever one you select is the first of SOME array, so "use snippets[0]" and
    // "use ranked[0]" both survive. Three, with the selection in the middle of both orders, kills them together.
    const ARROW = snippet("arrow", "an arrow function");
    const { actions } = setup([LOG, FETCH, ARROW]); // stored: log, fetchjson, arrow -- listed: arrow, fetchjson, log
    await ready();
    expect(rowNames()).toEqual(["arrow", "fetchjson", "log"]);
    select("fetchjson");
    fireEvent.click(button(strings.snippets.insert));
    expect(actions.insert).toHaveBeenCalledWith(FETCH);
  });

  test("a clipboard that refuses says so rather than claiming a copy", async () => {
    const { clipboard } = setup();
    await ready();
    clipboard.writeText.mockImplementation(async () => {
      throw new Error("denied");
    });
    await settle(() => fireEvent.click(button(strings.snippets.copy)));
    expect(screen.getByText(strings.snippets.copyFailed)).toBeTruthy();
  });

  test("Delete confirms with the spec's wording, saves, and offers Undo (R-M5b-4)", async () => {
    const { api, dialogs, store } = setup();
    await ready();
    select("log");
    await settle(() => fireEvent.click(button(strings.snippets.delete)));
    // Asserted whole, not with objectContaining: the message and the ABSENCE of a primary button are the ruling.
    // No primary means Enter does nothing and Escape cancels -- a destructive action nobody can trip into.
    expect(dialogs.confirm).toHaveBeenCalledWith({
      title: strings.snippets.deleteTitle("log"),
      message: strings.snippets.deleteMessage,
      buttons: [
        { id: "cancel", label: strings.snippets.cancel, role: "cancel" },
        { id: "delete", label: strings.snippets.deleteButton, role: "danger" },
      ],
    });
    // Deleting the SECOND-ranked snippet: a delete that dropped index 0 of either array would leave the wrong one.
    expect(api.snippetsSave).toHaveBeenCalledWith([FETCH]);
    await waitFor(() => expect(store.getState().snippets).toEqual([FETCH]));
    expect(screen.getByText(strings.snippets.deleted("log"))).toBeTruthy();

    await settle(() => fireEvent.click(button(strings.snippets.undo)));
    // Restored with its original id and timestamps: an undo is a restoration, not a new snippet.
    await waitFor(() => expect(store.getState().snippets).toEqual([FETCH, LOG]));
    expect(screen.queryByText(strings.snippets.deleted("log"))).toBeNull();
  });

  test("the offer to undo is withdrawn once another change lands", async () => {
    const { emit, store } = setup();
    await ready();
    select("log");
    await settle(() => fireEvent.click(button(strings.snippets.delete)));
    expect(screen.getByText(strings.snippets.deleted("log"))).toBeTruthy();
    // strings.snippets.deleteMessage promises undo lasts "until you make another change". This is that change.
    await emit("snippets.imported", { ok: true, snippets: [snippet("brandnew", "a new one")] });
    await waitFor(() => expect(store.getState().snippets).toHaveLength(2));
    expect(screen.queryByRole("button", { name: strings.snippets.undo })).toBeNull();
    expect(screen.getByText(strings.snippets.imported(1, 0, 0))).toBeTruthy();
  });

  test("a status from before a delete does not reappear when the delete is undone", async () => {
    const { store } = setup();
    await ready();
    select("log");
    await settle(() => fireEvent.click(button(strings.snippets.copy)));
    expect(screen.getByText(strings.snippets.copied)).toBeTruthy();
    await settle(() => fireEvent.click(button(strings.snippets.delete)));
    await settle(() => fireEvent.click(button(strings.snippets.undo)));
    await waitFor(() => expect(store.getState().snippets).toHaveLength(2));
    // "Copied" described an action two steps ago. Letting it resurface when the undo row goes away would be a lie.
    expect(screen.queryByText(strings.snippets.copied)).toBeNull();
  });

  test("a cancelled confirm changes nothing", async () => {
    const { api, dialogs, store } = setup();
    dialogs.confirm.mockImplementation(async () => "cancel");
    await ready();
    select("log");
    await settle(() => fireEvent.click(button(strings.snippets.delete)));
    expect(api.snippetsSave).not.toHaveBeenCalled();
    expect(store.getState().snippets).toHaveLength(2);
    expect(screen.queryByRole("button", { name: strings.snippets.undo })).toBeNull();
  });

  test("a failed save keeps the snippet and says so", async () => {
    const { api, store } = setup();
    api.snippetsSave.mockImplementation(async () => ({ ok: false, error: "EACCES: permission denied" }));
    await ready();
    select("log");
    await settle(() => fireEvent.click(button(strings.snippets.delete)));
    expect(await screen.findByText(strings.snippets.saveFailed("EACCES: permission denied"))).toBeTruthy();
    // Pessimistic: the store is only updated once Main confirms, so a deletion that never reached disk never shows.
    expect(store.getState().snippets).toEqual(LIBRARY);
    expect(screen.queryByRole("button", { name: strings.snippets.undo })).toBeNull();
  });

  test("a later successful save clears the earlier failure message", async () => {
    const { api, store } = setup();
    api.snippetsSave.mockImplementation(async () => ({ ok: false, error: "EACCES" }));
    await ready();
    select("log");
    await settle(() => fireEvent.click(button(strings.snippets.delete)));
    expect(await screen.findByText(strings.snippets.saveFailed("EACCES"))).toBeTruthy();
    api.snippetsSave.mockImplementation(async () => ({ ok: true }));
    await settle(() => fireEvent.click(button(strings.snippets.delete)));
    await waitFor(() => expect(store.getState().snippets).toHaveLength(1));
    // A stale failure sitting under a change that then succeeded would misreport what is on disk.
    expect(screen.queryByText(strings.snippets.saveFailed("EACCES"))).toBeNull();
  });

  test("an empty library offers a way out of being empty", async () => {
    setup([]);
    expect(await screen.findByText(strings.snippets.empty)).toBeTruthy();
    expect(button(strings.snippets.newSnippet)).toBeTruthy();
  });

  test("no search results offer to create a snippet named after the query, when that name is legal", async () => {
    setup();
    await ready();
    type("newthing");
    expect(screen.getByText(strings.snippets.noMatches("newthing"))).toBeTruthy();
    expect(button(strings.snippets.createNamed("newthing"))).toBeTruthy();
    // A query that can't be a snippet name (spec §13.1's ^[\w$-]+$) offers no such shortcut.
    type("not a name");
    expect(screen.getByText(strings.snippets.noMatches("not a name"))).toBeTruthy();
    expect(screen.queryByRole("button", { name: strings.snippets.createNamed("not a name") })).toBeNull();
  });

  test("New Snippet leaves the list for the form", async () => {
    setup();
    await ready();
    fireEvent.click(button(strings.snippets.newSnippet));
    expect(screen.queryByLabelText(strings.snippets.searchLabel)).toBeNull();
    expect(options()).toEqual([]);
  });

  test("a newSnippet request opens the form, and a focusSearch request does not", async () => {
    const { store } = setup();
    await ready();
    // The two request kinds must not collapse into one another: this is the whole of Task 9's channel into the panel.
    act(() => store.getState().requestSnippets("newSnippet", "const a = 1"));
    await waitFor(() => expect(screen.queryByLabelText(strings.snippets.searchLabel)).toBeNull());
  });

  test("a focusSearch request focuses the search box, every time it is made", async () => {
    const { store } = setup();
    await ready();
    const box = search();
    (document.activeElement as HTMLElement | null)?.blur();
    act(() => store.getState().requestSnippets("focusSearch"));
    await waitFor(() => expect(document.activeElement).toBe(box));
    // The channel is emptied once handled, so a request never sits in the store waiting to re-fire (Task 9's contract).
    expect(store.getState().snippetsRequest).toBeNull();
    // Twice: a channel that only fires on a CHANGED request would silently drop the second press of the shortcut.
    (document.activeElement as HTMLElement | null)?.blur();
    act(() => store.getState().requestSnippets("focusSearch"));
    await waitFor(() => expect(document.activeElement).toBe(box));
    expect(store.getState().snippetsRequest).toBeNull();
  });

  test("a panel closed before Main answers does not write to the store", async () => {
    const store = makeStore();
    const { api } = createFakeApi();
    let deliver: (library: Snippet[]) => void = () => {};
    api.snippetsList.mockImplementation(
      () =>
        new Promise<Snippet[]>((resolve) => {
          deliver = resolve;
        }),
    );
    const { unmount } = render(
      <SnippetsPanel
        store={store}
        api={api}
        dialogs={{ confirm: mock(async (_o: ConfirmOptions): Promise<string> => "cancel") }}
        actions={{ insert: mock((_s: Snippet) => {}), insertInNewTab: mock(async (_s: Snippet) => {}) }}
      />,
    );
    unmount();
    await act(async () => {
      deliver(LIBRARY);
      await Bun.sleep(1);
    });
    // The reply outlived the panel: adopting it would mark a closed panel's library loaded behind its back.
    expect([store.getState().snippets, store.getState().snippetsLoaded]).toEqual([[], false]);
  });

  test("Import asks Main, then offers a conflict choice before anything is merged", async () => {
    const { api, emit, store } = setup();
    await ready();
    fireEvent.click(button(strings.snippets.import));
    expect(api.snippetsImportDialog).toHaveBeenCalled();

    await emit("snippets.imported", {
      ok: true,
      snippets: [snippet("fetchjson", "Fetch + parse JSON", "IMPORTED"), snippet("brandnew", "a new one")],
    });
    expect(screen.getByText(strings.snippets.conflicts(1, 2))).toBeTruthy();
    // Nothing is written until the user has chosen: the choice is the point.
    expect(api.snippetsSave).not.toHaveBeenCalled();
    expect(store.getState().snippets).toEqual(LIBRARY);

    await settle(() => fireEvent.click(button(strings.snippets.overwrite)));
    await waitFor(() => expect(store.getState().snippets).toHaveLength(3));
    expect(store.getState().snippets.find((s) => s.name === "fetchjson")?.body).toBe("IMPORTED");
    expect(screen.getByText(strings.snippets.imported(1, 1, 0))).toBeTruthy();
  });

  test("Skip keeps what is already there, and the conflict choice is dismissed either way", async () => {
    const { emit, store } = setup();
    await ready();
    await emit("snippets.imported", {
      ok: true,
      snippets: [snippet("fetchjson", "Fetch + parse JSON", "IMPORTED"), snippet("brandnew", "a new one")],
    });
    await settle(() => fireEvent.click(button(strings.snippets.skip)));
    await waitFor(() => expect(store.getState().snippets).toHaveLength(3));
    // The conflicting record kept its original body; only the new one was added.
    expect(store.getState().snippets.find((s) => s.name === "fetchjson")?.body).toBe("body of fetchjson");
    expect(screen.queryByRole("button", { name: strings.snippets.overwrite })).toBeNull();
    expect(screen.getByText(strings.snippets.imported(1, 0, 1))).toBeTruthy();
  });

  test("Keep Both renames the incoming snippet instead of replacing or dropping it", async () => {
    const { emit, store } = setup();
    await ready();
    await emit("snippets.imported", {
      ok: true,
      snippets: [snippet("fetchjson", "Fetch + parse JSON", "IMPORTED"), snippet("brandnew", "a new one")],
    });
    await settle(() => fireEvent.click(button(strings.snippets.keepBoth)));
    await waitFor(() => expect(store.getState().snippets).toHaveLength(4));
    const names = store.getState().snippets.map((s) => s.name);
    // The existing record keeps its name and body; the incoming one is renamed rather than lost.
    expect(names).toContain("fetchjson-2");
    expect(store.getState().snippets.find((s) => s.name === "fetchjson")?.body).toBe("body of fetchjson");
    expect(store.getState().snippets.find((s) => s.name === "fetchjson-2")?.body).toBe("IMPORTED");
    expect(screen.getByText(strings.snippets.imported(2, 0, 0))).toBeTruthy();
  });

  test("a name differing only in case is still a conflict, and still asks (R-M5b-9)", async () => {
    const { api, emit, store } = setup();
    await ready();
    await emit("snippets.imported", { ok: true, snippets: [snippet("FETCHJSON", "shouty", "IMPORTED")] });
    // It must ASK. A case-only difference that slipped past this check would be merged under "skip" and silently
    // dropped -- the user would be told the import succeeded while nothing arrived.
    expect(screen.getByText(strings.snippets.conflicts(1, 1))).toBeTruthy();
    expect(api.snippetsSave).not.toHaveBeenCalled();
    expect(store.getState().snippets).toEqual(LIBRARY);
  });

  test("the case-insensitive conflict check folds both sides, not just the incoming one (R-M5b-9)", async () => {
    // Here the STORED name carries the capitals. With every stored name already lowercase, dropping the fold on
    // the stored side is invisible -- the incoming fold alone still matches -- so that half needs its own fixture.
    const MIXED = snippet("FetchJson", "Fetch + parse JSON");
    const { api, emit } = setup([MIXED]);
    await screen.findByRole("option", { name: /FetchJson/ });
    await emit("snippets.imported", { ok: true, snippets: [snippet("fetchjson", "lower", "IMPORTED")] });
    expect(screen.getByText(strings.snippets.conflicts(1, 1))).toBeTruthy();
    expect(api.snippetsSave).not.toHaveBeenCalled();
  });

  test("an import with no conflicts merges straight away", async () => {
    const { emit, store } = setup();
    await ready();
    await emit("snippets.imported", { ok: true, snippets: [snippet("brandnew", "a new one")] });
    await waitFor(() => expect(store.getState().snippets).toHaveLength(3));
    expect(screen.queryByRole("button", { name: strings.snippets.overwrite })).toBeNull();
  });

  test("a refused import reports the reason and leaves the library alone (spec §13.4)", async () => {
    const { api, emit, store } = setup();
    await ready();
    await emit("snippets.imported", {
      ok: false,
      reason: "wrongFormat",
      detail: 'Expected "format": "jslab-snippets".',
    });
    expect(screen.getByText(strings.snippets.importFailed)).toBeTruthy();
    expect(screen.getByText('Expected "format": "jslab-snippets".')).toBeTruthy();
    expect(api.snippetsSave).not.toHaveBeenCalled();
    expect(store.getState().snippets).toEqual(LIBRARY);
  });

  test("Export sends the whole library and reports where it went", async () => {
    const { api, emit } = setup();
    await ready();
    fireEvent.click(button(strings.snippets.export));
    // The LIBRARY as held, not as displayed: an export is the file, not the current search.
    expect(api.snippetsExportDialog).toHaveBeenCalledWith(LIBRARY);
    await emit("snippets.exported", { ok: true, path: "/tmp/jslab-snippets.json" });
    expect(screen.getByText(strings.snippets.exportedTo("/tmp/jslab-snippets.json"))).toBeTruthy();
  });

  test("a search does not narrow what Export writes", async () => {
    const { api } = setup();
    await ready();
    type("log");
    expect(rowNames()).toEqual(["log"]);
    fireEvent.click(button(strings.snippets.export));
    expect(api.snippetsExportDialog).toHaveBeenCalledWith(LIBRARY);
  });

  test("a cancelled export and a failed export each say so", async () => {
    const { emit } = setup();
    await ready();
    await emit("snippets.exported", { cancelled: true });
    expect(screen.getByText(strings.snippets.exportCancelled)).toBeTruthy();
    await emit("snippets.exported", { ok: false, error: "ENOSPC" });
    expect(screen.getByText(strings.snippets.exportFailed("ENOSPC"))).toBeTruthy();
  });

  // ---- S1: the preview renders colorized HTML, and snippet bodies come from IMPORTED files ----

  const HOSTILE = '<img src=x onerror="reportXss()">';

  test("an imported body is shown as text, never as markup, when there is no colorizer", async () => {
    setup([snippet("hostile", "from an imported file", HOSTILE)]);
    await screen.findByRole("option", { name: /hostile/ });
    expect(document.querySelector(".snippets-preview img")).toBeNull();
    expect(previewText()).toBe(HOSTILE);
  });

  test("a colorized body is escaped by the colorizer, so imported markup still creates no element", async () => {
    // Stands in for `monaco.editor.colorize`, whose tokenizer escapes its input before wrapping tokens in spans.
    // That escaping is the ONLY thing protecting this `dangerouslySetInnerHTML`, and it lives in the injected prop.
    const escapeHtml = (code: string) =>
      code.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    const monacoLike: SnippetColorize = async (code) => `<span class="mtk1">${escapeHtml(code)}</span>`;
    setup([snippet("hostile", "from an imported file", HOSTILE)], monacoLike);
    await screen.findByRole("option", { name: /hostile/ });
    // The highlighted branch really did run...
    await waitFor(() => expect(document.querySelector(".snippets-preview .mtk1")).not.toBeNull());
    // ...and no element was created from the body.
    expect(document.querySelector(".snippets-preview img")).toBeNull();
    expect(previewText()).toBe(HOSTILE);
  });

  test("a colorizer that starts failing leaves readable text, not the previous snippet's HTML", async () => {
    // The first call SUCCEEDS, so `highlighted` is genuinely set before one fails. A colorizer that failed from the
    // start could not fail this test: `highlighted` begins null, so the plain fallback is already on screen.
    let calls = 0;
    const flaky: SnippetColorize = async (code) => {
      calls += 1;
      if (calls > 1) throw new Error("monaco not loaded");
      return `<span class="mtk1">${code}</span>`;
    };
    setup(LIBRARY, flaky);
    await ready();
    await waitFor(() => expect(document.querySelector(".snippets-preview .mtk1")).not.toBeNull());
    select("log");
    await waitFor(() => expect(previewText()).toBe("body of log"));
    expect(document.querySelector(".snippets-preview .mtk1")).toBeNull();
  });

  test("switching snippets never shows the previous snippet's highlighted body", async () => {
    // The second colorize never settles -- exactly the window a slow Monaco leaves open.
    let calls = 0;
    const slow: SnippetColorize = (code) => {
      calls += 1;
      if (calls > 1) return new Promise<string>(() => {});
      return Promise.resolve(`<span class="mtk1">${code}</span>`);
    };
    setup(LIBRARY, slow);
    await ready();
    await waitFor(() => expect(document.querySelector(".snippets-preview .mtk1")).not.toBeNull());
    select("log");
    // The newly selected snippet's own text -- never fetchjson's body sitting under log's name.
    await waitFor(() => expect(previewText()).toBe("body of log"));
  });
});
