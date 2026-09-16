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
});
