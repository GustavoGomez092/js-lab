import { describe, expect, test } from "bun:test";
import { strings } from "../src/strings";

describe("interpolated strings keep their English output (spec §17)", () => {
  test("single and multiple placeholders", () => {
    expect(strings.install.package("zod")).toBe("Install package zod");
    expect(strings.files.saved("a.ts")).toBe("Saved a.ts");
    expect(strings.shell.cursor(3, 12)).toBe("Ln 3, Col 12");
    expect(strings.output.frame("run", 4, 9)).toBe("at run (L4:9)");
  });

  test("a nullable argument still selects between two phrasings", () => {
    expect(strings.shell.runState.paused("⌘R")).toBe("Paused: press ⌘R to run");
    expect(strings.shell.runState.paused(null)).toBe("Paused");
    expect(strings.output.noOutput(null)).toBe("No output yet");
  });

  test("an unknown error is coerced, not stringified as [object Object]", () => {
    expect(strings.format.failed("boom")).toBe("Couldn't format: boom");
    expect(strings.commands.failed("Run", new Error("boom"))).toBe("Run failed: boom");
    expect(strings.commands.failed("Run", "boom")).toBe("Run failed: boom");
  });

  test("plurals select by count, in both directions", () => {
    expect(strings.shell.runState.settled(1)).toBe("Running: 1 active handle");
    expect(strings.shell.runState.settled(2)).toBe("Running: 2 active handles");
    expect(strings.npm.typesHidden(1)).toBe("1 @types package hidden.");
    expect(strings.npm.typesHidden(3)).toBe("3 @types packages hidden.");
    expect(strings.env.pasted(1)).toBe("Added 1 variable from the paste. Check them, then Save.");
    expect(strings.env.pasted(2)).toBe("Added 2 variables from the paste. Check them, then Save.");
  });

  test("the zero case of env.saved keeps its own sentence, not a pluralized one", () => {
    // This string is not a plural of the others: removing everything says something different.
    expect(strings.env.saved(0)).toBe("Removed all environment variables. The next run starts without them.");
    expect(strings.env.saved(1)).toBe("Saved 1 environment variable. The next run uses them.");
    expect(strings.env.saved(2)).toBe("Saved 2 environment variables. The next run uses them.");
  });

  test("no interpolated string leaks an unreplaced placeholder", () => {
    // A renamed variable is the classic i18n regression: the key resolves, the value renders "{{name}}".
    const rendered = [
      strings.install.types("@types/node"),
      strings.files.closeTitle("a.ts"),
      strings.npm.weekly(1234),
      strings.npm.majorTitle("zod", "3.0.0", "4.0.0"),
      strings.settings.loadFailed("nope"),
      strings.shell.workingDirectory.change("/tmp"),
      strings.palette.themeItem("Nord"),
      strings.env.valueTooLong("KEY", 4096),
    ];
    for (const value of rendered) expect(value).not.toContain("{{");
  });

  /**
   * The two plurals the plan's inventory omits, and the two counted strings that must keep their
   * thousands separator: `toLocaleString` formatting happens before interpolation, because i18next
   * renders a bare number as "1234".
   */
  test("the snippets plurals and the locale-formatted counts survive the sweep", () => {
    expect(strings.snippets.imported(1, 2, 3)).toBe("Imported 1 snippet, replaced 2, skipped 3.");
    expect(strings.snippets.imported(2, 0, 0)).toBe("Imported 2 snippets, replaced 0, skipped 0.");
    expect(strings.snippets.conflicts(1, 1)).toBe("1 snippet to import, 1 with a name you already use.");
    expect(strings.snippets.conflicts(2, 5)).toBe("5 snippets to import, 2 with a name you already use.");
    expect(strings.npm.weekly(1234)).toBe("1,234 weekly downloads");
    expect(strings.output.moreEntries(1234)).toBe("… 1,234 more entries");
  });

  /**
   * `npm.running`, `npm.rowStatus`, `npm.failed` and `npm.done` used to splice an English verb into a
   * sentence. Each `kind` is now its own key, and every key is a STRING LITERAL at the call site -- a
   * template-literal key would be invisible to the key check's `t("...")` scan and would read as unused.
   */
  test("the npm progress strings select a key per kind, not a verb per sentence", () => {
    expect(strings.npm.running("install", "zod", 0)).toBe("Installing zod…");
    expect(strings.npm.running("install", "zod", 2)).toBe("Installing zod… 2 more queued.");
    expect(strings.npm.running("update", "zod", 0)).toBe("Updating zod…");
    expect(strings.npm.running("updateAll", "", 0)).toBe("Updating all packages…");
    expect(strings.npm.running("remove", "zod", 0)).toBe("Removing zod…");
    expect(strings.npm.rowStatus("install", "queued")).toBe("Queued");
    expect(strings.npm.rowStatus("remove", "running")).toBe("Removing…");
    expect(strings.npm.failed("updateAll", "")).toBe("Couldn't update all packages.");
    expect(strings.npm.failed("remove", "zod")).toBe("Couldn't remove zod.");
    expect(strings.npm.done("install", "zod", null)).toBe("Installed zod.");
    expect(strings.npm.done("install", "zod", "⌘R")).toBe("Installed zod. Press ⌘R to run again.");
    expect(strings.npm.doneFailed("install", "zod", "Check your connection.")).toBe(
      "Couldn't install zod. Check your connection.",
    );
  });
});
