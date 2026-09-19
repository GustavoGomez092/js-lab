import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
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

  /**
   * OU-13, with nothing stubbed: a URL the running program printed is rendered as a control, activated FROM THE
   * KEYBOARD, sent over the real RPC, revalidated by Main against the same allowlist the UI used, and handed to
   * the one external-link path -- which an E2E launch records to `e2e-external.txt` rather than opening a browser.
   */
  test("a URL in output opens in the browser when activated from the keyboard (OU-13)", async () => {
    app = await launchApp();
    const href = "https://example.com/jslab-ou13";
    const recorded = join(app.userData, "e2e-external.txt");
    // The control: nothing has opened a link yet, so the file below appearing is caused by this test's gesture.
    expect(existsSync(recorded)).toBe(false);
    await app.type(`console.log("${href}")`);
    await app.waitForOutput((all) => all.some((entry) => entry.text.includes(href)));
    await app.command("e2e.openOutputLink", { via: "keyboard" });
    await waitFor(async () => (existsSync(recorded) && (await readFile(recorded, "utf8")).includes(href)) || null, {
      timeoutMs: 15_000,
      message: "The output URL never reached openExternal",
    });
  });
});
