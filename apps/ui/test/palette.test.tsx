import { describe, expect, mock, test } from "bun:test";
import { createTab, DEFAULT_KEYBINDINGS, defaultSession, defaultSettings, resolveKeybindings } from "@jslab/shared";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { CommandRegistry } from "../src/commands/registry";
import { type EditorHandle, setEditorHandle } from "../src/editor/editor-handle";
import { CommandPalette } from "../src/palette/CommandPalette";
import { buildSections, matchTitle, type PaletteItem } from "../src/palette/match";
import { createAppStore } from "../src/state/store";
import { strings } from "../src/strings";

function hydratedStore() {
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

describe("palette matching", () => {
  test("ranks prefix, word prefix, substring and subsequence matches", () => {
    expect(matchTitle("tog", "Toggle Auto Run")).toMatchObject({ ranges: [[0, 3]] });
    expect(matchTitle("auto", "Toggle Auto Run")).toMatchObject({ ranges: [[7, 11]] });
    expect(matchTitle("gle", "Toggle Auto Run")).toMatchObject({ score: 100, ranges: [[3, 6]] });
    expect(matchTitle("tar", "Toggle Auto Run")).toMatchObject({
      score: 10,
      ranges: [
        [0, 1],
        [7, 8],
        [12, 13],
      ],
    });
    expect(matchTitle("xyz", "Toggle Auto Run")).toBeNull();
    const prefix = matchTitle("tog", "Toggle Auto Run")?.score ?? 0;
    const word = matchTitle("auto", "Toggle Auto Run")?.score ?? 0;
    expect(prefix).toBeGreaterThan(word);
    expect(word).toBeGreaterThan(100);
  });

  test("sections follow category order, hide disabled and editor-only items in output context, and rank by query", () => {
    const item = (
      id: string,
      title: string,
      category: PaletteItem["category"],
      extra: Partial<PaletteItem> = {},
    ): PaletteItem => ({
      id: id as PaletteItem["id"],
      title,
      category,
      context: "any",
      description: null,
      keys: [],
      enabled: true,
      ...extra,
    });
    const items = [
      item("view.toggleOutput", "Toggle Output Panel", "view"),
      item("run.toggleAutoRun", "Toggle Auto Run", "run"),
      item("edit.duplicateLine", "Duplicate Line", "edit", { context: "editor" }),
      item("output.clear", "Clear Output", "edit", { context: "output" }),
      item("run.kill", "Kill", "run", { enabled: false }),
    ];
    expect(buildSections(items, "", "editor").map((s) => [s.label, s.items.map((i) => i.title)])).toEqual([
      ["Run", ["Toggle Auto Run"]],
      ["Edit", ["Duplicate Line", "Clear Output"]],
      ["View", ["Toggle Output Panel"]],
    ]);
    expect(buildSections(items, "", "output").flatMap((s) => s.items.map((i) => i.title))).not.toContain(
      "Duplicate Line",
    );
    // "Clear Output" matches at index 6 and "Toggle Output Panel" at 7, so Edit's best match ranks first.
    expect(buildSections(items, "output", "editor").map((s) => s.label)).toEqual(["Edit", "View"]);
  });

  // FB-m1: the unfiltered list was capped at 60 rows in category order, so Runtime, Language, Theme, Help and JSLab
  // were unreachable without typing.
  test("an empty query lists every section, including Theme and Help; a query keeps the cap (FB-m1)", () => {
    const item = (index: number, category: PaletteItem["category"]): PaletteItem => ({
      id: "edit.duplicateLine" as PaletteItem["id"],
      args: { index },
      title: `Command ${index}`,
      category,
      context: "any",
      description: null,
      keys: [],
      enabled: true,
    });
    const items = [
      ...Array.from({ length: 90 }, (_, index) => item(index, "edit")),
      item(90, "theme"),
      item(91, "help"),
      item(92, "app"),
    ];
    const empty = buildSections(items, "", "editor");
    expect(empty.map((section) => section.category)).toEqual(["edit", "theme", "help", "app"]);
    expect(empty.flatMap((section) => section.items)).toHaveLength(93);
    expect(empty.map((section) => section.label)).toEqual([
      strings.palette.categories.edit,
      strings.palette.categories.theme,
      strings.palette.categories.help,
      strings.palette.categories.app,
    ]);
    expect(buildSections(items, "command", "editor").flatMap((section) => section.items)).toHaveLength(60);
  });

  // Fix round 1 (I-2): without the context bonus, both items tie on score and the earlier index (run.stop,
  // context "output") would win; the bonus must be what promotes run.start (context "editor") ahead of it.
  test("the context bonus, not array order, decides ties between equally scored matches", () => {
    const item = (id: string, context: PaletteItem["context"]): PaletteItem => ({
      id: id as PaletteItem["id"],
      title: "Run",
      category: "run",
      context,
      description: null,
      keys: [],
      enabled: true,
    });
    const items = [item("run.stop", "output"), item("run.start", "editor")];
    expect(buildSections(items, "run", "editor").flatMap((s) => s.items.map((i) => i.id))).toEqual([
      "run.start",
      "run.stop",
    ]);
  });
});

function setup(context: "editor" | "output" = "editor", options: { open?: boolean } = {}) {
  const store = hydratedStore();
  const runs = { autoRun: mock(() => {}), output: mock(() => {}), duplicate: mock(() => {}), clear: mock(() => {}) };
  const registry = new CommandRegistry();
  registry.register(
    { id: "run.toggleAutoRun", run: runs.autoRun, description: () => "currently on" },
    { id: "view.toggleOutput", run: runs.output },
    { id: "edit.duplicateLine", run: runs.duplicate },
    { id: "output.clear", run: runs.clear },
  );
  render(<CommandPalette store={store} registry={registry} bindings={resolveKeybindings(DEFAULT_KEYBINDINGS, [])} />);
  if (options.open ?? true) act(() => store.getState().openModal({ kind: "palette", context }));
  return { store, runs };
}

describe("CommandPalette", () => {
  test("typing filters with highlighted matches, descriptions and keycaps; arrows and Enter run the command", () => {
    const { store, runs } = setup();
    expect(screen.getByTestId("palette-context").textContent).toBe("Editor");
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "tog" } });
    const options = screen.getAllByRole("option");
    expect(options.map((o) => o.querySelector(".palette-title")?.textContent)).toEqual([
      "Toggle Auto Run",
      "Toggle Output Panel",
    ]);
    expect(options[0]?.querySelector("mark")?.textContent).toBe("Tog");
    expect(options[0]?.querySelector(".palette-desc")?.textContent).toBe("currently on");
    expect([...(options[0]?.querySelectorAll(".palette-keys b") ?? [])].map((b) => b.textContent)).toEqual([
      "⌥",
      "⌘",
      "A",
    ]);
    expect(options[0]?.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.getAllByRole("option")[1]?.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(runs.output).toHaveBeenCalledTimes(1);
    expect(store.getState().modal).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("opened from the output, editor-only commands are hidden; Escape closes", () => {
    const { store } = setup("output");
    expect(screen.getByTestId("palette-context").textContent).toBe("Output");
    const titles = screen.getAllByRole("option").map((o) => o.querySelector(".palette-title")?.textContent);
    expect(titles).toContain("Clear Output");
    expect(titles).not.toContain("Duplicate Line");
    expect(screen.getByText("esc")).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
    expect(store.getState().modal).toBeNull();
  });

  // Fix round 1 (I-1). Before the fix, a mousedown anywhere in the panel besides the input or a row (the
  // footer here) blurs the input to body in a real browser, and Escape/⌘⇧P/↑↓/Enter stop reaching anything: the
  // input no longer gets the event and the global resolver skips view.commandPalette entirely while a modal is
  // open. This suite's DOM (happy-dom) doesn't implement that default focus-follows-mousedown action at all, so
  // `document.activeElement` can't distinguish fixed from broken here (it would stay on the input either way —
  // confirmed by probing happy-dom directly). The load-bearing assertion is that the panel itself calls
  // preventDefault() for a mousedown anywhere but the input: that's the actual mechanism (option (a) of the
  // review) that stops a real browser from moving focus away, and `fireEvent` reports it via its return value
  // (`false` means the event's default was prevented). The activeElement/Escape assertions are kept as
  // regression guards for the still-passing case.
  test("a mousedown on the footer or a row is prevented so it can't steal focus off the input; the input keeps handling keys", () => {
    const { store } = setup();
    const input = screen.getByRole("combobox");
    const foot = document.querySelector(".palette-foot");
    const row = screen.getAllByRole("option")[0];
    if (!foot || !row) throw new Error("expected the footer and at least one row to be present");
    expect(fireEvent.mouseDown(foot)).toBe(false);
    expect(fireEvent.mouseDown(row)).toBe(false);
    expect(fireEvent.mouseDown(input)).toBe(true);
    expect(document.activeElement).toBe(input);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(store.getState().modal).toBeNull();
  });

  test("theme items show as 'Theme: <name>', mark the current theme, and Enter passes { themeId }", () => {
    const store = hydratedStore();
    const runTheme = mock((_args?: unknown) => {});
    const registry = new CommandRegistry();
    registry.register({ id: "theme.select", run: runTheme });
    render(<CommandPalette store={store} registry={registry} bindings={resolveKeybindings(DEFAULT_KEYBINDINGS, [])} />);
    act(() => store.getState().openModal({ kind: "palette", context: "editor" }));
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "graphite" } });
    const options = screen.getAllByRole("option");
    expect(options[0]?.querySelector(".palette-title")?.textContent).toBe("Theme: Graphite");
    expect(options[0]?.querySelector(".palette-desc")?.textContent).toBe("current");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(runTheme).toHaveBeenCalledWith({ themeId: "graphite" });
    expect(store.getState().modal).toBeNull();
  });

  test("clicking a row runs it; a mousedown on the scrim closes without running anything", () => {
    const { store, runs } = setup();
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "tog" } });
    const outputOption = screen
      .getAllByRole("option")
      .find((option) => option.querySelector(".palette-title")?.textContent === "Toggle Output Panel");
    if (!outputOption) throw new Error("expected a Toggle Output Panel option");
    fireEvent.click(outputOption);
    expect(runs.output).toHaveBeenCalledTimes(1);
    expect(store.getState().modal).toBeNull();

    act(() => store.getState().openModal({ kind: "palette", context: "editor" }));
    const scrim = document.querySelector(".palette-scrim");
    if (!scrim) throw new Error("expected the scrim");
    fireEvent.mouseDown(scrim);
    expect(store.getState().modal).toBeNull();
    expect(runs.output).toHaveBeenCalledTimes(1);
  });

  // Fix round 1 (I-2, m-4): mirrors RenameDialog's own focus-restore coverage.
  test("closing restores focus to the previously focused element", () => {
    const { store } = setup("editor", { open: false });
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    try {
      opener.focus();
      act(() => store.getState().openModal({ kind: "palette", context: "editor" }));
      expect(document.activeElement).not.toBe(opener);
      fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
      expect(document.activeElement).toBe(opener);
    } finally {
      opener.remove();
    }
  });

  // Fix round 1 (m-4): mirrors RenameDialog's `document.contains` guard and `getEditorHandle()` fallback — a
  // previously focused element that was removed while the palette was open must not strand focus (or throw).
  test("closing falls back to the editor when the previously focused element was removed", () => {
    const editorFocus = mock(() => {});
    setEditorHandle({ focus: editorFocus } as unknown as EditorHandle);
    try {
      const { store } = setup("editor", { open: false });
      const opener = document.createElement("button");
      document.body.appendChild(opener);
      opener.focus();
      act(() => store.getState().openModal({ kind: "palette", context: "editor" }));
      opener.remove();
      fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
      expect(editorFocus).toHaveBeenCalledTimes(1);
    } finally {
      setEditorHandle(null);
    }
  });

  // Fix round 1 (m-2): the in-panel close chord follows a rebound view.commandPalette keybinding rather than a
  // hard-coded ⌘⇧P.
  test("the in-panel close chord follows a rebound view.commandPalette keybinding", () => {
    const store = hydratedStore();
    const registry = new CommandRegistry();
    registry.register({ id: "view.toggleOutput", run: () => {} });
    const bindings = resolveKeybindings(DEFAULT_KEYBINDINGS, [{ key: "ctrl+k", command: "view.commandPalette" }]);
    render(<CommandPalette store={store} registry={registry} bindings={bindings} />);
    act(() => store.getState().openModal({ kind: "palette", context: "editor" }));
    const input = screen.getByRole("combobox");
    fireEvent.keyDown(input, { code: "KeyP", metaKey: true, shiftKey: true });
    expect(store.getState().modal).not.toBeNull();
    fireEvent.keyDown(input, { code: "KeyK", ctrlKey: true });
    expect(store.getState().modal).toBeNull();
  });

  // UI item 2: both focus commands have to be offered from BOTH sides (a command with context "editor" is dropped
  // when the palette is opened from the output), and their keycaps come from the effective bindings -- this app
  // renders keycaps from resolved bindings everywhere, so a rebind must show through here too.
  test("the focus commands are listed from either side and show their effective, rebindable keycaps", () => {
    const store = hydratedStore();
    const registry = new CommandRegistry();
    registry.register({ id: "view.focusOutput", run: () => {} }, { id: "view.focusEditor", run: () => {} });
    // view.focusOutput is rebound; view.focusEditor keeps its default ⌥⌘E.
    const bindings = resolveKeybindings(DEFAULT_KEYBINDINGS, [{ key: "cmd+shift+y", command: "view.focusOutput" }]);
    render(<CommandPalette store={store} registry={registry} bindings={bindings} />);

    const keysOf = (title: string) => {
      const option = screen
        .getAllByRole("option")
        .find((candidate) => candidate.querySelector(".palette-title")?.textContent === title);
      if (!option) throw new Error(`expected a "${title}" option`);
      return [...option.querySelectorAll(".palette-keys b")].map((b) => b.textContent);
    };

    for (const context of ["editor", "output"] as const) {
      act(() => store.getState().openModal({ kind: "palette", context }));
      fireEvent.change(screen.getByRole("combobox"), { target: { value: "focus" } });
      expect(keysOf("Focus Output")).toEqual(["⇧", "⌘", "Y"]);
      expect(keysOf("Focus Editor")).toEqual(["⌥", "⌘", "E"]);
      act(() => store.getState().closeModal());
    }
  });
});
