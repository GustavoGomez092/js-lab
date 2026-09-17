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

  /**
   * R-M5d-ALIAS-1: adding a user rule does NOT delete the command's default.
   *
   * `resolveKeybindings` only drops a default for a `-command` removal rule or when another command takes the
   * chord, so ⌘R goes on running Run here. A row showing one keycap would say otherwise.
   */
  test("a plain user rule ADDS a chord rather than replacing the default, and the row says so", () => {
    const added = [{ key: "cmd+shift+enter", command: "run.start" }];
    expect(row("run.start", added)?.chords).toEqual([
      { key: "cmd+r", label: "⌘R" },
      { key: "cmd+shift+enter", label: "⇧⌘↩" },
    ]);
  });

  test("a removal rule retires the default chord, leaving only what replaced it", () => {
    const replaced = [
      { key: "cmd+r", command: "-run.start" },
      { key: "cmd+j", command: "run.start" },
    ];
    expect(row("run.start", replaced)?.chords).toEqual([{ key: "cmd+j", label: "⌘J" }]);
    expect(row("run.start", replaced)?.key).toBe("cmd+j");
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

  /**
   * R-M5d-ALIAS-1. This test previously pinned the opposite: that a command with two default chords shows only the
   * highest-precedence one.
   *
   * That was a real defect, not a simplification. Spec §6.5 lists `Cmd+Alt+Right` / `Cmd+Alt+Left` as the PRIMARY
   * bindings for Next/Previous Tab, and both chords genuinely fire -- the resolver matches by chord, so neither
   * default shadows the other. Showing one keycap per row made the primary binding impossible to discover and
   * impossible to reset. One row per command still stands (R-M5D-REGISTRY-1); the row now carries every chord.
   */
  test("lists EVERY chord bound to a command, in resolution order", () => {
    expect(row("tab.next")?.chords).toEqual([
      { key: "cmd+alt+right", label: "⌥⌘→" },
      { key: "ctrl+tab", label: "⌃⇥" },
    ]);
    expect(row("tab.previous")?.chords).toEqual([
      { key: "cmd+alt+left", label: "⌥⌘←" },
      { key: "ctrl+shift+tab", label: "⌃⇧⇥" },
    ]);
    // The scalar keycap still reports the highest-precedence chord, so the row cannot disagree with `shortcutFor`
    // -- which is what the native menu and the palette render.
    expect(row("tab.next")?.key).toBe("ctrl+tab");
    expect(row("tab.previous")?.key).toBe("ctrl+shift+tab");
    // A singly-bound command has exactly one, so "list them all" cannot be read as "always list two".
    expect(row("run.start")?.chords).toEqual([{ key: "cmd+r", label: "⌘R" }]);
    expect(row("run.toggleLoopProtection")?.chords).toEqual([]);
  });

  test("a command that keeps another chord simply loses the one taken from it", () => {
    const taken = [{ key: "cmd+alt+right", command: "run.kill" }];
    // ⌥⌘→ now runs Kill, so Next Tab must stop claiming it -- but ⌃⇥ still works and is still listed. Nothing is
    // ambiguous here, so there is nothing to warn about either.
    expect(row("tab.next", taken)?.chords).toEqual([{ key: "ctrl+tab", label: "⌃⇥" }]);
    expect(row("tab.next", taken)?.conflicts).toEqual([]);
    expect(row("run.kill", taken)?.chords).toEqual([
      { key: "cmd+alt+r", label: "⌥⌘R" },
      { key: "cmd+alt+right", label: "⌥⌘→" },
    ]);
  });

  test("reports which commands keybindings.json carries a rule for, removals included", () => {
    const rules = [
      { key: "cmd+j", command: "run.start" },
      { key: "cmd+k", command: "-output.clear" },
    ];
    expect(row("run.start", rules)?.customized).toBe(true);
    expect(row("output.clear", rules)?.customized).toBe(true);
    expect(row("run.stop", rules)?.customized).toBe(false);
    expect(row("run.start")?.customized).toBe(false);
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

  /**
   * A later binding in a genuinely different context does NOT take the chord away.
   *
   * `KeybindingResolver.resolve` takes the last chord match whose `when` PASSES, so with ⌘/ bound to an
   * output-scoped command, ⌘/ *in the editor* still reaches Toggle Line Comment. Treating any later same-chord
   * binding as a takeover would silently delete a keycap that still works -- and it has to be the non-leading
   * chord that proves it, because a command's leading chord is kept either way to carry the conflict warning.
   */
  test("a later binding in a different context does not take the chord away", () => {
    const scoped = [
      { key: "cmd+;", command: "edit.toggleLineComment" },
      { key: "cmd+/", command: "run.stop", when: "outputFocus" },
    ];
    expect(row("edit.toggleLineComment", scoped)?.chords).toEqual([
      { key: "cmd+/", label: "⌘/" },
      { key: "cmd+;", label: "⌘;" },
    ]);
    // ...and the two contexts really are disjoint, so neither row warns about the other.
    expect(row("edit.toggleLineComment", scoped)?.conflicts).toEqual([]);
    expect(row("run.stop", scoped)?.conflicts).toEqual([]);
  });

  test("a later binding in the SAME context does take the chord away", () => {
    const same = [
      { key: "cmd+;", command: "edit.toggleLineComment" },
      { key: "cmd+/", command: "run.stop", when: "editorFocus" },
    ];
    // ⌘/ in the editor now runs Stop, so Toggle Line Comment must stop claiming it.
    expect(row("edit.toggleLineComment", same)?.chords).toEqual([{ key: "cmd+;", label: "⌘;" }]);
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

  /**
   * Conflicts are checked against every chord a row holds, not just its leading one.
   *
   * Run ends up with three chords; the MIDDLE one collides with Close Other Tabs. Checking only the
   * highest-precedence chord (⌘Y) would report no conflict at all, on either row.
   */
  test("reports a conflict on any of a row's chords, not only the highest-precedence one", () => {
    const many = [
      { key: "cmd+alt+t", command: "run.start" },
      { key: "cmd+y", command: "run.start" },
    ];
    expect(row("run.start", many)?.chords.map((chord) => chord.key)).toEqual(["cmd+r", "cmd+alt+t", "cmd+y"]);
    expect(row("run.start", many)?.key).toBe("cmd+y");
    expect(row("run.start", many)?.conflicts).toEqual(["tab.closeOthers"]);
    expect(row("tab.closeOthers", many)?.conflicts).toEqual(["run.start"]);
  });

  test("search matches the title, the command id, the keycap and the chord spec, case-insensitively", () => {
    expect(ids([], "reopen")).toEqual(["tab.reopenClosed"]);
    // A term that appears in the TITLE only: the id is "output.showAll", which the space stops matching. Without
    // it, dropping the title from the haystack still passes, because "reopen" also matches "tab.reopenClosed".
    expect(ids([], "show all")).toEqual(["output.showAll"]);
    expect(ids([], "run.kill")).toEqual(["run.kill"]);
    expect(ids([], "⌘R")).toContain("run.start");
    expect(ids([], "cmd+alt+r")).toContain("run.kill");
    // Searchable on an ALIAS chord too, not only the leading one: ⌥⌘→ is Next Tab's primary binding but not its
    // highest-precedence one, so a haystack built from the effective chord alone would never find it.
    expect(ids([], "cmd+alt+right")).toEqual(["tab.next"]);
    expect(ids([], "⌥⌘←")).toEqual(["tab.previous"]);
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
