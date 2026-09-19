import { afterEach, describe, expect, test } from "bun:test";
import { activeTab, type LaunchedApp, launchApp, waitFor } from "../src";

let app: LaunchedApp | null = null;
afterEach(async () => {
  await app?.dispose();
  app = null;
});

type Options = Record<string, unknown>;
const options = async (target: LaunchedApp) => (await target.state()).ui.editorOptions as Options;

describe("appearance", () => {
  test("editor settings apply to Monaco, and zoom scales the font (ED-01, ED-03..ED-07, ED-27, ST-06)", async () => {
    app = await launchApp({
      settings: {
        version: 2,
        editor: { lineWrap: false, lineNumbers: false, invisibles: true, activeLine: true, closeBrackets: false },
        appearance: { font: "Fira Code", fontSize: 18, fontLigatures: false },
      },
    });
    expect(await options(app)).toMatchObject({
      wordWrap: "off",
      lineNumbers: "off",
      renderWhitespace: "all",
      renderLineHighlight: "all",
      autoClosingBrackets: "never",
      fontSize: 18,
      fontLigatures: false,
    });
    expect(String((await options(app)).fontFamily)).toContain("Fira Code");
    await app.command("view.zoomIn");
    await waitFor(async () => (await options(app as LaunchedApp)).fontSize === 20 || null);
    await app.screenshot("appearance-zoomed");
    await app.command("view.zoomReset");
    await waitFor(async () => (await options(app as LaunchedApp)).fontSize === 18 || null);
  });

  test("a font that isn't installed falls back to JetBrains Mono with a notice (ST-05)", async () => {
    app = await launchApp({ settings: { version: 2, appearance: { font: "Definitely Not A Font" } } });
    const state = await waitFor(async () => {
      const s = await (app as LaunchedApp).state();
      return s.ui.fontFallback ? s : null;
    });
    expect(String(state.ui.statusMessage)).toContain("Definitely Not A Font");
    expect(String((state.ui.editorOptions as Options).fontFamily)).toContain("JetBrains Mono Variable");
  });

  test("Hover Info and Signatures reach Monaco, both on and off (ED-10, ED-11)", async () => {
    app = await launchApp({ settings: { version: 2, editor: { hoverInfo: false, signatures: false } } });
    // Monaco's own answer, not the settings that were written. `getOptions()` reads `editor.getRawOptions()`, and
    // `hoverEnabled` comes back as Monaco 0.56's "on"/"off" (see `toMonacoOptions`) -- a shape the boolean setting
    // never had, so a value echoed from settings could not produce it.
    expect(await options(app)).toMatchObject({ hoverEnabled: "off", parameterHints: false });
    await app.dispose();
    // Both polarities in one test, so no hardcoded constant can satisfy the pair.
    app = await launchApp({ settings: { version: 2, editor: { hoverInfo: true, signatures: true } } });
    expect(await options(app)).toMatchObject({ hoverEnabled: "on", parameterHints: true });
  });

  test("Vim Keys starts in normal mode and ⌘R still runs (ED-02)", async () => {
    app = await launchApp({ settings: { version: 2, run: { autoRun: false }, editor: { vimKeys: true } } });
    // The editor mounts after hydrate, so wait for Vim to report its mode (review M10).
    await waitFor(async () => (await (app as LaunchedApp).state()).ui.vimMode === "normal" || null);
    await app.type("6 * 7");
    // FA-m10: wait for the edit itself, then for the auto-run delay from settings plus a margin. The window is what
    // this negative check is about (Auto Run is off, so nothing may run); it is no longer a guess at a debounce.
    const typed = await waitFor(async () => {
      const s = await (app as LaunchedApp).state();
      return activeTab(s).code === "6 * 7" ? s : null;
    });
    await Bun.sleep(Number(typed.ui.settings?.run?.autoRunDelayMs ?? 300) + 1_500);
    expect(activeTab(await app.state())).toMatchObject({ entryCount: 0, runState: null });
    await app.key("cmd+r");
    await app.waitForOutput((all) => all.some((e) => e.text === "42"));
  });
});
