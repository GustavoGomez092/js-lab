import { describe, expect, test } from "bun:test";
import { COMMAND_CATEGORY_ORDER, COMMANDS, commandMeta, isCommandId } from "../src/commands";
import { DEFAULT_KEYBINDINGS } from "../src/keybindings";

describe("command catalogue", () => {
  test("ids are unique, titled and categorised", () => {
    const ids = COMMANDS.map((command) => command.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const command of COMMANDS) {
      expect(command.title.length).toBeGreaterThan(0);
      expect(COMMAND_CATEGORY_ORDER).toContain(command.category);
    }
    for (const m1 of ["run.start", "run.stop", "run.kill", "output.clear", "editor.clear"]) {
      expect(isCommandId(m1)).toBe(true);
    }
  });

  test("lookups reject unknown ids", () => {
    expect(commandMeta("tab.reopenClosed")).toMatchObject({ title: "Reopen Closed Tab", category: "tab" });
    expect(commandMeta("nope")).toBeUndefined();
    expect(isCommandId("-run.start")).toBe(false);
  });

  test("M3 adds the Tools category, the working-directory commands and ⌘I for NPM Packages", () => {
    expect(COMMAND_CATEGORY_ORDER.indexOf("tools")).toBe(COMMAND_CATEGORY_ORDER.indexOf("view") + 1);
    expect(commandMeta("tools.npmPackages")).toMatchObject({ title: "NPM Packages…", category: "tools" });
    expect(commandMeta("tools.environmentVariables")).toMatchObject({ category: "tools" });
    expect(commandMeta("wd.set")).toMatchObject({ title: "Set Working Directory…", category: "run" });
    expect(commandMeta("wd.clear")).toMatchObject({ title: "Clear Working Directory", category: "run" });
    expect(commandMeta("npm.install")).toMatchObject({ palette: false });
    expect(DEFAULT_KEYBINDINGS.filter((rule) => rule.key === "cmd+i")).toEqual([
      { key: "cmd+i", command: "tools.npmPackages" },
    ]);
  });

  // The Web View toggle shipped as a status-bar button only, so it was unreachable from the palette, the menu
  // and E2E automation (parity WV-01, TF-19).
  test("M4 adds a Web View toggle command with a default chord", () => {
    expect(commandMeta("view.toggleWebView")).toMatchObject({ title: "Toggle Web View", category: "view" });
    expect(DEFAULT_KEYBINDINGS.filter((rule) => rule.command === "view.toggleWebView")).toEqual([
      { key: "alt+cmd+w", command: "view.toggleWebView" },
    ]);
  });

  test("M5a adds the logpoint commands with the spec's chords (spec §6.3, §6.5)", () => {
    expect(commandMeta("edit.toggleLogpoint")).toMatchObject({
      title: "Toggle Logpoint",
      category: "edit",
      context: "editor",
    });
    expect(commandMeta("edit.clearLogpoints")).toMatchObject({
      title: "Clear All Logpoints",
      category: "edit",
      context: "editor",
    });
    expect(
      DEFAULT_KEYBINDINGS.filter((rule) => rule.command.endsWith("Logpoint") || rule.command.endsWith("Logpoints")),
    ).toEqual([
      { key: "f9", command: "edit.toggleLogpoint", when: "editorFocus" },
      { key: "cmd+shift+f9", command: "edit.clearLogpoints" },
    ]);
  });

  test("M5a adds Show Transpiled Output with no default chord (spec §7.4)", () => {
    expect(commandMeta("view.showTranspiled")).toMatchObject({
      title: "Show Transpiled Output",
      category: "view",
    });
    expect(DEFAULT_KEYBINDINGS.filter((rule) => rule.command === "view.showTranspiled")).toEqual([]);
  });

  // UI item 2: the output scroller is focusable, but from Monaco Tab inserts a tab character, so nothing reached
  // it from the keyboard. ⌥⌘ is this app's existing panel family (⌥⌘W Web View, ⌥⌘\ layout); ⌥⌘O and ⌥⌘E were
  // both unused, in every context.
  test("M5d adds the focus commands with free ⌥⌘ chords (UI item 2)", () => {
    expect(commandMeta("view.focusOutput")).toMatchObject({ title: "Focus Output", category: "view" });
    expect(commandMeta("view.focusEditor")).toMatchObject({ title: "Focus Editor", category: "view" });
    // Neither declares a context: the palette drops editor-only commands when it is opened from the output, so a
    // context of "editor" on Focus Editor would hide it from precisely the place it exists to escape.
    expect(commandMeta("view.focusOutput")?.context).toBeUndefined();
    expect(commandMeta("view.focusEditor")?.context).toBeUndefined();
    expect(DEFAULT_KEYBINDINGS.filter((rule) => rule.command.startsWith("view.focus"))).toEqual([
      { key: "alt+cmd+o", command: "view.focusOutput" },
      { key: "alt+cmd+e", command: "view.focusEditor" },
    ]);
    // Unconditional on purpose: a `when` clause is what would stop Focus Output working from the editor, and
    // Focus Editor from the output -- the only two journeys either command has.
    for (const rule of DEFAULT_KEYBINDINGS.filter((r) => r.command.startsWith("view.focus"))) {
      expect(rule.when).toBeUndefined();
    }
  });
});
