import { describe, expect, mock, test } from "bun:test";
import { createTab, DEFAULT_KEYBINDINGS, defaultSession, defaultSettings, resolveKeybindings } from "@jslab/shared";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { CommandRegistry } from "../src/commands/registry";
import { type EditorHandle, setEditorHandle } from "../src/editor/editor-handle";
import { CommandPalette } from "../src/palette/CommandPalette";
import { buildSections, firstEnabledIndex, matchTitle, type PaletteItem, stepEnabledIndex } from "../src/palette/match";
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

  // R-M4-PALETTE-HIDE-1: this test used to assert that disabled items were *dropped* here. Dropping them meant
  // "Kill" with nothing running rendered `strings.palette.empty` ("No matching commands") -- the same answer a
  // typo gets. They now rank on score alone and render in place; only the selection skips them.
  test("sections follow category order, keep disabled items in place, hide editor-only items in output context, and rank by query", () => {
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
      ["Run", ["Toggle Auto Run", "Kill"]],
      ["Edit", ["Duplicate Line", "Clear Output"]],
      ["View", ["Toggle Output Panel"]],
    ]);
    // A query matching only the disabled command returns it, carrying `enabled: false` through ranking -- that
    // flag is what the renderer greys out and what the selection skips.
    expect(buildSections(items, "kill", "editor").flatMap((s) => s.items.map((i) => [i.title, i.enabled]))).toEqual([
      ["Kill", false],
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

  // R-M4-PALETTE-HIDE-1: the navigation half of the fix. Disabled rows are visible but never selectable, so
  // `flat[selected]` is always runnable and Enter never becomes a silent no-op on a row the user can see.
  test("selection helpers skip disabled rows, stop at the ends, and report when nothing can run", () => {
    const rows = (...flags: boolean[]) => flags.map((enabled) => ({ enabled }));
    expect(firstEnabledIndex(rows(false, false, true))).toBe(2);
    expect(firstEnabledIndex(rows(true, false))).toBe(0);
    expect(firstEnabledIndex(rows(false, false))).toBe(-1);
    // Moving down off a disabled leading row lands on the first enabled row, not merely on the next index.
    expect(stepEnabledIndex(rows(false, false, true), 0, 1)).toBe(2);
    expect(stepEnabledIndex(rows(true, false, true), 0, 1)).toBe(2);
    expect(stepEnabledIndex(rows(true, false, true), 2, -1)).toBe(0);
    // Stops at the ends rather than wrapping, matching the Math.min/Math.max behaviour it replaced.
    expect(stepEnabledIndex(rows(true, false, true), 2, 1)).toBe(2);
    expect(stepEnabledIndex(rows(true, false, true), 0, -1)).toBe(0);
    // A trailing run of disabled rows holds the current selection instead of moving onto one of them.
    expect(stepEnabledIndex(rows(true, false, false), 0, 1)).toBe(0);
    // Nothing enabled anywhere: -1, so the caller drops aria-activedescendant and Enter has no target.
    expect(stepEnabledIndex(rows(false, false), 0, 1)).toBe(-1);
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

/** R-M4-PALETTE-HIDE-1: registers the audit's own measured cases -- `run.kill` ("Kill") disabled because nothing
 * is running, and `tab.reopenClosed` ("Reopen Closed Tab") disabled on an empty stack. `CommandSpec.isEnabled`
 * is a bare boolean, so neither can say *why*; the palette only has to say "exists, not right now". A separate
 * setup from `setup()` above on purpose: adding a disabled row there would shift every other test's row 0. */
function setupWithDisabled() {
  const store = hydratedStore();
  const runs = { kill: mock(() => {}), autoRun: mock(() => {}), reopen: mock(() => {}) };
  const registry = new CommandRegistry();
  registry.register(
    { id: "run.kill", run: runs.kill, isEnabled: () => false },
    { id: "run.toggleAutoRun", run: runs.autoRun },
    { id: "tab.reopenClosed", run: runs.reopen, isEnabled: () => false },
  );
  render(<CommandPalette store={store} registry={registry} bindings={resolveKeybindings(DEFAULT_KEYBINDINGS, [])} />);
  act(() => store.getState().openModal({ kind: "palette", context: "editor" }));
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

  // R-M4-PALETTE-HIDE-1, the defect itself: with nothing running, "Kill" returned "No matching commands" --
  // byte-identical to what a typo or a misremembered name returns. The command now says it exists.
  test("a search whose only match is disabled lists it, greyed and labelled, instead of 'No matching commands'", () => {
    const { store, runs } = setupWithDisabled();
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "kill" } });
    expect(screen.queryByText(strings.palette.empty)).toBeNull();
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(1);
    const row = options[0];
    if (!row) throw new Error("expected the disabled Kill row to be listed");
    expect(row.querySelector(".palette-title")?.textContent).toBe("Kill");
    expect(row.getAttribute("aria-disabled")).toBe("true");
    expect(row.querySelector(".palette-unavailable")?.textContent).toBe(strings.palette.unavailable);
    // Nothing listed can run, so the row never takes the selection, the combobox points at no option, and
    // Enter is a genuine no-op that leaves the palette (and its explanation) open.
    expect(row.getAttribute("aria-selected")).toBe("false");
    expect(input.getAttribute("aria-activedescendant")).toBeNull();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(runs.kill).not.toHaveBeenCalled();
    expect(store.getState().modal).not.toBeNull();
  });

  // The other half of the distinction: making a disabled command visible must not make the empty state
  // unreachable, or the two answers collapse again from the opposite direction.
  test("a query that genuinely matches nothing still says 'No matching commands'", () => {
    setupWithDisabled();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "zzzz" } });
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText(strings.palette.empty)).toBeTruthy();
  });

  test("arrow keys skip disabled rows, so the selection and Enter always land on a runnable command", () => {
    const { store, runs } = setupWithDisabled();
    const input = screen.getByRole("combobox");
    const titles = () => screen.getAllByRole("option").map((o) => o.querySelector(".palette-title")?.textContent);
    const selectedTitle = () =>
      screen
        .getAllByRole("option")
        .find((o) => o.getAttribute("aria-selected") === "true")
        ?.querySelector(".palette-title")?.textContent;
    // Both disabled commands are listed, in catalogue order, around the one enabled command.
    expect(titles()).toEqual(["Kill", "Toggle Auto Run", "Reopen Closed Tab"]);
    // Row 0 is disabled, so the initial selection is the first *enabled* row rather than index 0.
    expect(selectedTitle()).toBe("Toggle Auto Run");
    expect(input.getAttribute("aria-activedescendant")).toBe("palette-option-1");
    // Down and up each find only a disabled neighbour, so the selection holds instead of landing on one.
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(selectedTitle()).toBe("Toggle Auto Run");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(selectedTitle()).toBe("Toggle Auto Run");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(runs.autoRun).toHaveBeenCalledTimes(1);
    expect(runs.kill).not.toHaveBeenCalled();
    expect(runs.reopen).not.toHaveBeenCalled();
    expect(store.getState().modal).toBeNull();
  });

  test("clicking or hovering a disabled row neither runs it nor closes the palette", () => {
    const { store, runs } = setupWithDisabled();
    const killRow = screen.getAllByRole("option")[0];
    if (!killRow) throw new Error("expected the disabled Kill row to be listed");
    fireEvent.click(killRow);
    expect(runs.kill).not.toHaveBeenCalled();
    // Closing here would dismiss the very explanation the user opened the palette to find.
    expect(store.getState().modal).not.toBeNull();
    fireEvent.mouseMove(killRow);
    expect(killRow.getAttribute("aria-selected")).toBe("false");
  });
});
