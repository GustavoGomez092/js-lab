import { describe, expect, mock, test } from "bun:test";
import { createTab, DEFAULT_KEYBINDINGS, defaultSession, defaultSettings, resolveKeybindings } from "@jslab/shared";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { CommandRegistry } from "../src/commands/registry";
import { CommandPalette } from "../src/palette/CommandPalette";
import { buildSections, matchTitle, type PaletteItem } from "../src/palette/match";
import { createAppStore } from "../src/state/store";

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
});

function setup(context: "editor" | "output" = "editor") {
  const store = createAppStore();
  store.getState().hydrate({
    settings: defaultSettings(),
    session: defaultSession(() => createTab({ id: "t1" })),
    buffers: { t1: "" },
    safeMode: { active: false, reason: null },
    versions: { app: "0", bun: "1.4.0" },
  });
  const runs = { autoRun: mock(() => {}), output: mock(() => {}), duplicate: mock(() => {}), clear: mock(() => {}) };
  const registry = new CommandRegistry();
  registry.register(
    { id: "run.toggleAutoRun", run: runs.autoRun, description: () => "currently on" },
    { id: "view.toggleOutput", run: runs.output },
    { id: "edit.duplicateLine", run: runs.duplicate },
    { id: "output.clear", run: runs.clear },
  );
  render(<CommandPalette store={store} registry={registry} bindings={resolveKeybindings(DEFAULT_KEYBINDINGS, [])} />);
  act(() => store.getState().openModal({ kind: "palette", context }));
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
});
