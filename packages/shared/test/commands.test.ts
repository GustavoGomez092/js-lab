import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COMMAND_CATEGORY_ORDER, COMMANDS, commandMeta, commandTitleKey, isCommandId } from "../src/commands";
import { DEFAULT_KEYBINDINGS } from "../src/keybindings";

const EN = join(import.meta.dir, "..", "..", "..", "apps", "ui", "src", "i18n", "locales", "en.json");
const en = JSON.parse(readFileSync(EN, "utf8")) as Record<string, unknown>;

/** Resolves a dotted key the way Main's own translator does: one segment at a time, no joined-segment lookup. */
const lookup = (key: string): unknown =>
  key
    .split(".")
    .reduce<unknown>(
      (node, segment) =>
        typeof node === "object" && node !== null ? (node as Record<string, unknown>)[segment] : undefined,
      en,
    );

describe("command catalogue", () => {
  test("ids are unique and categorised", () => {
    const ids = COMMANDS.map((command) => command.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const command of COMMANDS) {
      expect(COMMAND_CATEGORY_ORDER).toContain(command.category);
    }
    for (const m1 of ["run.start", "run.stop", "run.kill", "output.clear", "editor.clear"]) {
      expect(isCommandId(m1)).toBe(true);
    }
  });

  test("lookups reject unknown ids", () => {
    expect(commandMeta("tab.reopenClosed")).toMatchObject({ category: "tab" });
    expect(commandMeta("nope")).toBeUndefined();
    expect(isCommandId("-run.start")).toBe(false);
  });

  test("M3 adds the Tools category, the working-directory commands and ⌘I for NPM Packages", () => {
    expect(COMMAND_CATEGORY_ORDER.indexOf("tools")).toBe(COMMAND_CATEGORY_ORDER.indexOf("view") + 1);
    expect(commandMeta("tools.npmPackages")).toMatchObject({ category: "tools" });
    expect(commandMeta("tools.environmentVariables")).toMatchObject({ category: "tools" });
    expect(commandMeta("wd.set")).toMatchObject({ category: "run" });
    expect(commandMeta("wd.clear")).toMatchObject({ category: "run" });
    expect(commandMeta("npm.install")).toMatchObject({ palette: false });
    expect(DEFAULT_KEYBINDINGS.filter((rule) => rule.key === "cmd+i")).toEqual([
      { key: "cmd+i", command: "tools.npmPackages" },
    ]);
  });

  // The Web View toggle shipped as a status-bar button only, so it was unreachable from the palette, the menu
  // and E2E automation (parity WV-01, TF-19).
  test("M4 adds a Web View toggle command with a default chord", () => {
    expect(commandMeta("view.toggleWebView")).toMatchObject({ category: "view" });
    expect(DEFAULT_KEYBINDINGS.filter((rule) => rule.command === "view.toggleWebView")).toEqual([
      { key: "alt+cmd+w", command: "view.toggleWebView" },
    ]);
  });

  test("M5a adds the logpoint commands with the spec's chords (spec §6.3, §6.5)", () => {
    expect(commandMeta("edit.toggleLogpoint")).toMatchObject({ category: "edit", context: "editor" });
    expect(commandMeta("edit.clearLogpoints")).toMatchObject({ category: "edit", context: "editor" });
    expect(
      DEFAULT_KEYBINDINGS.filter((rule) => rule.command.endsWith("Logpoint") || rule.command.endsWith("Logpoints")),
    ).toEqual([
      { key: "f9", command: "edit.toggleLogpoint", when: "editorFocus" },
      { key: "cmd+shift+f9", command: "edit.clearLogpoints" },
    ]);
  });

  test("M5a adds Show Transpiled Output with no default chord (spec §7.4)", () => {
    expect(commandMeta("view.showTranspiled")).toMatchObject({ category: "view" });
    expect(DEFAULT_KEYBINDINGS.filter((rule) => rule.command === "view.showTranspiled")).toEqual([]);
  });

  test("M5b adds the snippet commands, ⌘B and the Tab expansion (spec §13, §6.5)", () => {
    expect(commandMeta("tools.snippets")).toMatchObject({ category: "tools" });
    expect(commandMeta("snippets.create")).toMatchObject({ category: "edit", context: "editor" });
    expect(commandMeta("snippets.import")).toMatchObject({ category: "tools" });
    expect(commandMeta("snippets.export")).toMatchObject({ category: "tools" });
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

  // M5c §16.1: the menu shows exactly one of the pair, so only the install half is offered in the palette --
  // otherwise the palette would advertise "Uninstall" to someone who has never installed it.
  test("M5c adds the jslab install pair, with uninstall kept out of the palette", () => {
    expect(commandMeta("help.installCli")).toMatchObject({ category: "help" });
    expect(commandMeta("help.uninstallCli")).toMatchObject({ category: "help", palette: false });
    expect(commandMeta("help.installCli")?.palette).toBeUndefined();
  });

  // UI item 2: the output scroller is focusable, but from Monaco Tab inserts a tab character, so nothing reached
  // it from the keyboard. ⌥⌘ is this app's existing panel family (⌥⌘W Web View, ⌥⌘\ layout); ⌥⌘O and ⌥⌘E were
  // both unused, in every context.
  test("M5d adds the focus commands with free ⌥⌘ chords (UI item 2)", () => {
    expect(commandMeta("view.focusOutput")).toMatchObject({ category: "view" });
    expect(commandMeta("view.focusEditor")).toMatchObject({ category: "view" });
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

describe("command titles come from the catalogue (spec §17)", () => {
  test("every command's key is derived from its id, so the two cannot drift", () => {
    expect(commandTitleKey("run.start")).toBe("commands.run.start");
    expect(COMMANDS.every((command) => commandTitleKey(command.id) === `commands.${command.id}`)).toBe(true);
  });

  test("no command carries an English title any more", () => {
    // The English lives in en.json now; a leftover `title` would be a second, drifting source.
    expect(COMMANDS.every((command) => !("title" in command))).toBe(true);
  });

  test("all 119 commands have an entry in en.json", () => {
    const missing = COMMANDS.filter((command) => typeof lookup(commandTitleKey(command.id)) !== "string");
    expect(missing.map((command) => command.id)).toEqual([]);
    // 114 through M5; ST-11 added Help → Documentation / Report Issue / What's New, TL-18 added AI Chat, and
    // M6 added Help → About.
    expect(COMMANDS.length).toBe(119);
  });

  // M6: About replaces the native macOS panel, so it is an ordinary command -- palette-visible, bindable and
  // dispatchable from both menus that carry it.
  test("M6 adds the About command to the Help category, visible in the palette", () => {
    expect(commandMeta("help.about")).toMatchObject({ category: "help" });
    expect(commandMeta("help.about")?.palette).toBeUndefined();
    expect(lookup(commandTitleKey("help.about"))).toBe("About JSLab");
  });

  test("the entries are nested, never flat dotted keys, because Main walks one segment at a time", () => {
    // apps/desktop/src/main/i18n.ts splits a key on "." and descends segment by segment. Unlike i18next it has
    // no greedy joined-segment lookup, so a catalogue shaped {"commands": {"run.start": "Run"}} resolves to
    // nothing and every native menu item would read its own raw key. Measured: t("commands.run.start") returned
    // "commands.run.start" against that shape.
    const commands = en.commands as Record<string, unknown>;
    expect(Object.keys(commands).filter((key) => key.includes("."))).toEqual([]);
    expect(lookup("commands.run.start")).toBe("Run");
  });

  test("the English the per-command assertions used to pin is what the catalogue now serves", () => {
    // Relocated, not dropped: these are the exact titles the `toMatchObject({ title })` assertions above
    // checked before the field was removed, so the same copy is still pinned -- one hop further along.
    const titles = Object.fromEntries(
      [
        "tab.reopenClosed",
        "tools.npmPackages",
        "wd.set",
        "wd.clear",
        "view.toggleWebView",
        "edit.toggleLogpoint",
        "edit.clearLogpoints",
        "view.showTranspiled",
        "tools.snippets",
        "snippets.create",
        "snippets.import",
        "snippets.export",
        "help.installCli",
        "help.uninstallCli",
        "view.focusOutput",
        "view.focusEditor",
      ].map((id) => [id, lookup(commandTitleKey(id))]),
    );
    expect(titles).toEqual({
      "tab.reopenClosed": "Reopen Closed Tab",
      "tools.npmPackages": "NPM Packages…",
      "wd.set": "Set Working Directory…",
      "wd.clear": "Clear Working Directory",
      "view.toggleWebView": "Toggle Web View",
      "edit.toggleLogpoint": "Toggle Logpoint",
      "edit.clearLogpoints": "Clear All Logpoints",
      "view.showTranspiled": "Show Transpiled Output",
      "tools.snippets": "Snippets…",
      "snippets.create": "Create Snippet…",
      "snippets.import": "Import Snippets…",
      "snippets.export": "Export Snippets…",
      "help.installCli": "Install jslab Command…",
      "help.uninstallCli": "Uninstall jslab Command…",
      "view.focusOutput": "Focus Output",
      "view.focusEditor": "Focus Editor",
    });
  });
});
