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

  test("M5b adds the snippet commands, ⌘B and the Tab expansion (spec §13, §6.5)", () => {
    expect(commandMeta("tools.snippets")).toMatchObject({ title: "Snippets…", category: "tools" });
    expect(commandMeta("snippets.create")).toMatchObject({
      title: "Create Snippet…",
      category: "edit",
      context: "editor",
    });
    expect(commandMeta("snippets.import")).toMatchObject({ title: "Import Snippets…", category: "tools" });
    expect(commandMeta("snippets.export")).toMatchObject({ title: "Export Snippets…", category: "tools" });
    // Hidden from the palette: it only means anything with a trigger word already typed.
    expect(commandMeta("snippets.expand")).toMatchObject({ palette: false });
    // The three palette-visible ones must NOT be hidden, which `palette: false` on the wrong entry would make them.
    for (const id of ["tools.snippets", "snippets.create", "snippets.import", "snippets.export"]) {
      expect([id, commandMeta(id)?.palette ?? true]).toEqual([id, true]);
    }
    expect(DEFAULT_KEYBINDINGS.filter((rule) => rule.key === "cmd+b")).toEqual([
      { key: "cmd+b", command: "tools.snippets" },
    ]);
    expect(DEFAULT_KEYBINDINGS.filter((rule) => rule.key === "tab")).toEqual([
      { key: "tab", command: "snippets.expand", when: "editorFocus" },
    ]);
  });
});
