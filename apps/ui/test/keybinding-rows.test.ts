import { describe, expect, test } from "bun:test";
import { COMMANDS, DEFAULT_KEYBINDINGS, type KeybindingRule } from "@jslab/shared";
import { keybindingRows } from "../src/settings/keybinding-rows";

const catalogue = COMMANDS.map((command) => ({
  id: command.id,
  title: command.title,
  category: command.category,
  registered: true,
}));

const rows = (rules: readonly KeybindingRule[] = [], query = "") =>
  keybindingRows(catalogue, DEFAULT_KEYBINDINGS, rules, query);
const row = (command: string, rules: readonly KeybindingRule[] = [], query = "") =>
  rows(rules, query).find((candidate) => candidate.command === command);
const ids = (rules: readonly KeybindingRule[] = [], query = "") => rows(rules, query).map((entry) => entry.command);

describe("keybindingRows", () => {
  // The cross-plan guarantee (R-M5D-REGISTRY-1), asserted on the UI side too: one row per catalogue entry, never a
  // curated subset, so a command added by M5a/M5b shows up here with no edit to this milestone.
  test("renders one row per command in the catalogue, in catalogue order", () => {
    expect(rows()).toHaveLength(COMMANDS.length);
    expect(new Set(ids()).size).toBe(COMMANDS.length);
    // Order is part of the contract: the table must not silently sort, which would scatter each category.
    expect(ids()).toEqual(COMMANDS.map((command) => command.id));
  });

  test("shows the default chord, its keycap, the command's own title/category and Default as the source", () => {
    expect(row("run.start")).toMatchObject({
      key: "cmd+r",
      keyLabel: "⌘R",
      when: null,
      source: "default",
      // Pinned so the row cannot quietly carry the id, or a hardcoded category, in place of the catalogue's values.
      title: "Run",
      category: "run",
      registered: true,
      conflicts: [],
    });
    expect(row("edit.find")?.category).toBe("edit");
  });

  // `resolveKeybindings` normalises through `chordToSpec`, so the row shows canonical modifier order rather than
  // whatever order the rule happened to be written in ("alt+cmd+a" in DEFAULT_KEYBINDINGS).
  test("reports the chord in canonical modifier order, not the raw rule text", () => {
    expect(row("run.toggleAutoRun")).toMatchObject({ key: "cmd+alt+a", keyLabel: "⌥⌘A" });
  });

  test("a user rule overrides the default and reports User", () => {
    expect(row("run.start", [{ key: "cmd+shift+enter", command: "run.start" }])).toMatchObject({
      key: "cmd+shift+enter",
      keyLabel: "⇧⌘↩",
      source: "user",
    });
  });

  test("a removal rule leaves the command unbound", () => {
    expect(row("output.clear", [{ key: "cmd+k", command: "-output.clear" }])).toMatchObject({
      key: null,
      keyLabel: null,
      when: null,
      source: "none",
      conflicts: [],
    });
  });

  // 38 of the 104 commands ship no default binding at all; they are still listed, just unbound.
  test("a command that was never bound is listed as unbound", () => {
    expect(row("run.toggleLoopProtection")).toMatchObject({ key: null, keyLabel: null, source: "none" });
  });

  test("carries the when clause through", () => {
    expect(row("edit.toggleLineComment")?.when).toBe("editorFocus");
    expect(row("run.start")?.when).toBeNull();
  });

  // One row per COMMAND means a command with two default chords can only show one. `shortcutFor` shows the
  // last (highest-precedence) binding, and this table matches it so the two can never disagree.
  test("a command with several default chords shows the highest-precedence one", () => {
    expect(row("tab.next")?.key).toBe("ctrl+tab");
    expect(row("tab.previous")?.key).toBe("ctrl+shift+tab");
  });

  test("the shipped defaults collide with nothing", () => {
    expect(rows().every((entry) => entry.conflicts.length === 0)).toBe(true);
  });

  test("reports conflicts in both directions when two commands share a chord in the same context", () => {
    const withConflict = [{ key: "cmd+r", command: "run.stop" }];
    expect(row("run.stop", withConflict)?.conflicts).toEqual(["run.start"]);
    expect(row("run.start", withConflict)?.conflicts).toEqual(["run.stop"]);
  });

  /**
   * A binding with no `when` fires in EVERY context, so it shadows a same-chord binding that is context-scoped.
   *
   * `KeybindingResolver.resolve` walks the bindings last-to-first and takes the first chord match whose `when`
   * passes; `evaluateWhen(undefined, …)` returns true. So with a user's global ⌘/ appended after the default
   * editorFocus ⌘/, pressing ⌘/ *in the editor* runs the user's command and Toggle Line Comment becomes
   * unreachable. Treating that as "not a conflict" would leave the table silently disagreeing with the
   * dispatcher on the commonest real collision.
   */
  test("an unscoped binding conflicts with a same-chord scoped one, because it shadows it everywhere", () => {
    const shadowing = [{ key: "cmd+/", command: "run.stop" }];
    expect(row("run.stop", shadowing)?.conflicts).toEqual(["edit.toggleLineComment"]);
    expect(row("edit.toggleLineComment", shadowing)?.conflicts).toEqual(["run.stop"]);
  });

  test("two genuinely different contexts on one chord are not reported as a conflict", () => {
    const disjoint = [
      { key: "cmd+shift+x", command: "run.stop", when: "outputFocus" },
      { key: "cmd+shift+x", command: "run.kill", when: "editorFocus" },
    ];
    expect(row("run.stop", disjoint)?.conflicts).toEqual([]);
    expect(row("run.kill", disjoint)?.conflicts).toEqual([]);
  });

  /**
   * Only the binding each command actually uses can collide. `run.start`'s default ⌘R is still present in the
   * resolved list after the user moves `run.start` elsewhere, but it is shadowed and can never fire, so it must
   * not be counted against whoever now holds ⌘R.
   */
  test("a shadowed binding is not counted as a conflict", () => {
    const moved = [
      { key: "cmd+r", command: "run.stop" },
      { key: "cmd+shift+enter", command: "run.start" },
    ];
    expect(row("run.stop", moved)?.conflicts).toEqual([]);
    // ...while the chord it moved ONTO is a real collision: ⇧⌘↩ is Insert Line Before in the editor.
    expect(row("run.start", moved)?.conflicts).toEqual(["edit.insertLineBefore"]);
  });

  test("search matches the title, the command id, the keycap and the chord spec, case-insensitively", () => {
    expect(ids([], "reopen")).toEqual(["tab.reopenClosed"]);
    // A term that appears in the TITLE only: the id is "output.showAll", which the space stops matching. Without
    // it, dropping the title from the haystack still passes, because "reopen" also matches "tab.reopenClosed".
    expect(ids([], "show all")).toEqual(["output.showAll"]);
    expect(ids([], "run.kill")).toEqual(["run.kill"]);
    expect(ids([], "⌘R")).toContain("run.start");
    expect(ids([], "cmd+alt+r")).toContain("run.kill");
    expect(ids([], "REOPEN")).toEqual(["tab.reopenClosed"]);
    expect(ids([], "   reopen   ")).toEqual(["tab.reopenClosed"]);
    expect(rows([], "zzzz")).toEqual([]);
  });

  test("an unregistered command is still listed, and says so", () => {
    const partial = catalogue.map((entry) => ({ ...entry, registered: entry.id !== "run.kill" }));
    const built = keybindingRows(partial, DEFAULT_KEYBINDINGS, [], "");
    expect(built).toHaveLength(COMMANDS.length);
    expect(built.find((entry) => entry.command === "run.kill")?.registered).toBe(false);
    expect(built.find((entry) => entry.command === "run.start")?.registered).toBe(true);
  });
});
