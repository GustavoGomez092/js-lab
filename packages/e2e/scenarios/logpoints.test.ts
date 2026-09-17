import { afterEach, describe, expect, test } from "bun:test";
import { activeTab, type LaunchedApp, launchApp, waitFor } from "../src";

let apps: LaunchedApp[] = [];
afterEach(async () => {
  for (const app of apps.reverse()) await app.dispose();
  apps = [];
});

/**
 * Two declarations and nothing else. Auto Log only instruments top-level *expression statements*
 * (`packages/transform/src/instrument.ts`), while a logpoint also logs a `VariableDeclaration` — so this program
 * logs nothing at all on its own, and a result row on line 2 can only have come from the logpoint. That makes the
 * attribution structural rather than timed: no `output.clear` and no "wait for the first run to finish" step, both
 * of which would only prove something about ordering.
 */
const CODE = "const a = 5\nconst b = a * 2";

/**
 * The caret lands wherever typing left it — the last line typed — and `edit.toggleLogpoint` reads it straight from
 * Monaco. Waiting for the store to report the same line keeps the toggle off a guessed line without needing
 * `edit.gotoLine`, which is Monaco's `editor.action.gotoLine` quick-input dialog and moves no caret by itself.
 */
const caretOnLine = (app: LaunchedApp, line: number) =>
  waitFor(async () => (await app.state()).ui.cursor?.line === line || null, {
    message: `the caret never reached line ${line}`,
  });

const logpointCount = (app: LaunchedApp, count: number, message: string) =>
  waitFor(
    async () => {
      const state = await app.state();
      return activeTab(state).logpoints.length === count ? state : null;
    },
    { message },
  );

describe("logpoints", () => {
  test("a logpoint logs its line's value, and the toggle alone triggers the run (EX-14, EX-16)", async () => {
    const app = await launchApp();
    apps.push(app);
    await app.type(CODE);
    await caretOnLine(app, 2);

    await app.command("edit.toggleLogpoint");
    const withLogpoint = await logpointCount(app, 1, "the logpoint never reached the store");
    expect(activeTab(withLogpoint).logpoints).toEqual([2]);

    // EX-16: nothing was edited, yet a run produced output — arming it is what the toggle itself did.
    // EX-14: and that run logged line 2's value.
    const entries = await app.waitForOutput((all) => all.some((entry) => entry.kind === "result" && entry.line === 2));
    // Every result row is the logpoint's. Auto Log contributes none to this program, so pinning the whole set
    // (not just "a row exists") also proves the row is not an Auto Log row that happened to land on line 2.
    expect(entries.filter((entry) => entry.kind === "result").map((entry) => [entry.line, entry.text])).toEqual([
      [2, "10"],
    ]);

    // EX-14: F9 reaches the very same command and toggles the line back off.
    await app.key("f9");
    await logpointCount(app, 0, "F9 never removed the logpoint");
  });

  test("Clear All Logpoints empties the set, and logpoints never survive a relaunch (EX-14, EX-15)", async () => {
    const app = await launchApp();
    apps.push(app);
    await app.type(CODE);
    await caretOnLine(app, 2);
    await app.command("edit.toggleLogpoint");
    await logpointCount(app, 1, "the logpoint never reached the store");

    await app.key("cmd+shift+f9");
    await logpointCount(app, 0, "⇧⌘F9 never cleared the logpoints");

    // EX-15: set one again, quit, and relaunch into the same data folder.
    await app.command("edit.toggleLogpoint");
    await logpointCount(app, 1, "the second logpoint never reached the store");
    await app.quit();

    const again = await launchApp({ userData: app.userData });
    apps.push(again);
    const restored = await again.state();
    // The buffer comes back (quitting flushes it — `quit-flush.test.ts`), so this really is the same tab restored,
    // and it is restored with no logpoints on it at all: they are never persisted (spec §10.1).
    expect(activeTab(restored).code).toBe(CODE);
    expect(restored.ui.tabs.map((tab) => tab.logpoints)).toEqual([[]]);
  });
});
