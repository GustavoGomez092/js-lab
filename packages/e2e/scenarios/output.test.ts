import { afterEach, describe, expect, test } from "bun:test";
import { type LaunchedApp, launchApp, waitFor } from "../src";

let app: LaunchedApp | null = null;
afterEach(async () => {
  await app?.dispose();
  app = null;
});

const current = () => app as LaunchedApp;

describe("output", () => {
  test("filter chips count levels and narrow the list (UI direction, OU-01)", async () => {
    app = await launchApp();
    await app.type('1 + 1\nconsole.log("hi")\nconsole.error("bad")\nnull.x');
    const state = await waitFor(async () => {
      const s = await current().state();
      return (s.ui.outputCounts as Record<string, number>).all === 4 ? s : null;
    });
    expect(state.ui.outputCounts).toEqual({ all: 4, results: 1, logs: 1, errors: 2 });
    expect((state.ui.regions as Record<string, boolean>).lineAnchors).toBe(true);
    await app.screenshot("output-all");
    await app.command("output.showErrors");
    await waitFor(async () => (await current().state()).ui.outputFilter === "errors" || null);
    await app.screenshot("output-errors");
    // Spec §5.11: a syntax error keeps the previous output, dimmed and labeled "Last successful run".
    await app.type("const = ;");
    await waitFor(async () => ((await current().state()).ui.regions as Record<string, boolean>).staleLabel || null);
  });

  test("highlighting and line numbers can be turned off (OU-16)", async () => {
    app = await launchApp({ settings: { version: 2, output: { highlighting: false, showLineNumbers: false } } });
    await app.type("[1, 'a']");
    await app.waitForOutput((all) => all.length === 1);
    const regions = (await app.state()).ui.regions as Record<string, boolean>;
    expect([regions.outputPlain, regions.lineAnchors]).toEqual([true, false]);
  });
});
