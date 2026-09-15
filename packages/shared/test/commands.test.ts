import { describe, expect, test } from "bun:test";
import { COMMAND_CATEGORY_ORDER, COMMANDS, commandMeta, isCommandId } from "../src/commands";

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
});
