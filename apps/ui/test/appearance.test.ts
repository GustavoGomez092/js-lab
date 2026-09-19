import { describe, expect, mock, test } from "bun:test";
import { createTab, defaultSession, defaultSettings, mergeSettings } from "@jslab/shared";
import { createViewCommands } from "../src/commands/view-commands";
import { editorOptionsFor } from "../src/editor/editor-options";
import { createVimStatusNode } from "../src/editor/vim-status";
import { createAppStore } from "../src/state/store";
import {
  applyAppearanceVariables,
  CJK_FALLBACK,
  DEFAULT_FONT,
  fontAvailable,
  fontStack,
  startAppearanceSync,
} from "../src/themes/fonts";
import { createFakeApi } from "./fake-api";

function hydrated(font = "JetBrains Mono") {
  const store = createAppStore();
  store.getState().hydrate({
    settings: mergeSettings(defaultSettings(), { appearance: { font } }),
    session: defaultSession(() => createTab({ id: "t1" })),
    buffers: { t1: "" },
    safeMode: { active: false, reason: null },
    versions: { app: "0", bun: "1.4.0" },
  });
  return store;
}

/** `spyOn` doesn't intercept happy-dom's `CSSStyleDeclaration.setProperty`; wrap it manually (see themes.test.ts). */
function countSetProperty(root: HTMLElement) {
  const counter = { calls: 0 };
  const original = root.style.setProperty.bind(root.style);
  root.style.setProperty = (...args: Parameters<typeof original>) => {
    counter.calls++;
    return original(...args);
  };
  return counter;
}

describe("editor options", () => {
  test("defaults map to Monaco options", () => {
    expect(editorOptionsFor(defaultSettings())).toEqual({
      fontFamily:
        '"JetBrains Mono Variable", "Hiragino Sans", "Hiragino Kaku Gothic ProN", "PingFang SC", "PingFang TC", ui-monospace, Menlo, monospace',
      fontSize: 14,
      fontLigatures: true,
      lineNumbers: "on",
      wordWrap: "on",
      autoClosingBrackets: "languageDefined",
      autoClosingQuotes: "languageDefined",
      renderWhitespace: "none",
      renderLineHighlight: "none",
      minimap: { enabled: false },
      quickSuggestions: true,
      suggestOnTriggerCharacters: true,
      hover: { enabled: true, delay: 400 },
      parameterHints: { enabled: true },
      // User report (M4): line 1 sat flush against the bottom edge of the active tab. Monaco owns its own scroll
      // region, so this is Monaco's `padding` option rather than CSS on `.editor` -- container padding fights
      // Monaco's layout and line-position maths. 12px is the inset the rest of the shell already uses
      // (`.output-toolbar`'s `padding: 0 12px`, `.entry`'s `5px 12px`), so the first line clears the tab bar by
      // the same gap content clears every other edge by. Bottom matches: `scrollBeyondLastLine` is false, so
      // without it the last line is jammed against the status bar.
      padding: { top: 12, bottom: 12 },
    });
  });

  test("toggled settings, zoom and a font fallback change the options", () => {
    const settings = mergeSettings(defaultSettings(), {
      editor: {
        lineNumbers: false,
        lineWrap: false,
        closeBrackets: false,
        invisibles: true,
        activeLine: true,
        hoverDelayMs: 900,
      },
      appearance: { font: "Fira Code", fontSize: 18, fontLigatures: false, uiScale: 1.1 },
    });
    expect(editorOptionsFor(settings)).toMatchObject({
      fontFamily:
        '"Fira Code", "Hiragino Sans", "Hiragino Kaku Gothic ProN", "PingFang SC", "PingFang TC", ui-monospace, Menlo, monospace',
      fontSize: 20,
      fontLigatures: false,
      lineNumbers: "off",
      wordWrap: "off",
      autoClosingBrackets: "never",
      renderWhitespace: "all",
      renderLineHighlight: "all",
      hover: { enabled: true, delay: 900 },
      // Scales with zoom the same way `fontSize` does (`--ui-scale` is a CSS var Monaco's numeric option cannot
      // read, so the scaling is applied here): round(12 * 1.1) === 13.
      padding: { top: 13, bottom: 13 },
    });
    expect(editorOptionsFor(settings, true).fontFamily).toBe(
      '"JetBrains Mono Variable", "Hiragino Sans", "Hiragino Kaku Gothic ProN", "PingFang SC", "PingFang TC", ui-monospace, Menlo, monospace',
    );
  });
});

describe("fonts", () => {
  test("bundled names map to their web font family; other names are system fonts", () => {
    expect(fontStack("Hack")).toBe(
      '"Hack", "Hiragino Sans", "Hiragino Kaku Gothic ProN", "PingFang SC", "PingFang TC", ui-monospace, Menlo, monospace',
    );
    expect(fontStack("SF Mono")).toBe(
      '"SF Mono", "Hiragino Sans", "Hiragino Kaku Gothic ProN", "PingFang SC", "PingFang TC", ui-monospace, Menlo, monospace',
    );
    expect(fontStack('Evil"Font')).toBe(
      '"EvilFont", "Hiragino Sans", "Hiragino Kaku Gothic ProN", "PingFang SC", "PingFang TC", ui-monospace, Menlo, monospace',
    );
  });

  test("availability compares text widths against generic fallbacks", () => {
    const widths: Record<string, number> = {
      "72px monospace": 100,
      "72px serif": 90,
      '72px "Real Font", monospace': 120,
      '72px "Real Font", serif': 120,
      '72px "Missing", monospace': 100,
      '72px "Missing", serif': 90,
    };
    const measure = (font: string) => widths[font] ?? 0;
    expect(fontAvailable("Real Font", measure)).toBe(true);
    expect(fontAvailable("Missing", measure)).toBe(false);
  });

  test("appearance sync writes CSS variables and falls back with a notice when a font is missing", async () => {
    const store = hydrated("Nope Mono");
    const root = document.createElement("div");
    const check = mock(async (font: string) => font !== "Nope Mono");
    const stop = startAppearanceSync(store, root, check);
    await Bun.sleep(1);
    expect(store.getState().fontFallback).toBe(true);
    expect(store.getState().statusMessage).toBe('Font "Nope Mono" isn\'t available; using JetBrains Mono.');
    expect(root.style.getPropertyValue("--code-font-family")).toContain("JetBrains Mono Variable");
    store
      .getState()
      .updateSettings(mergeSettings(defaultSettings(), { appearance: { font: "Fira Code", uiScale: 1.25 } }));
    await Bun.sleep(1);
    expect(store.getState().fontFallback).toBe(false);
    expect(root.style.getPropertyValue("--ui-scale")).toBe("1.25");
    // m-1 (fix round 1): once a later check finds the (new) font available, the stale fallback notice for the
    // font that failed is cleared automatically, not left standing forever.
    expect(store.getState().statusMessage).toBeNull();
    // m-1 continued: an unrelated status message must survive a later, unrelated successful font check.
    store.getState().setStatusMessage("unrelated notice");
    store
      .getState()
      .updateSettings(
        mergeSettings(store.getState().settings ?? defaultSettings(), { appearance: { font: "Ubuntu Mono" } }),
      );
    await Bun.sleep(1);
    expect(store.getState().fontFallback).toBe(false);
    expect(store.getState().statusMessage).toBe("unrelated notice");
    // Field-level guard (carried behavior, review R-M2-PF3 companion): mergeSettings re-parses the whole
    // settings object on every settings.changed, so an unrelated run.autoRun update must not reapply the
    // appearance CSS variables (compare this against startThemeSync's identical guard in themes/apply.ts).
    const counter = countSetProperty(root);
    store
      .getState()
      .updateSettings(mergeSettings(store.getState().settings ?? defaultSettings(), { run: { autoRun: true } }));
    await Bun.sleep(1);
    expect(counter.calls).toBe(0);
    stop();
    applyAppearanceVariables(root, defaultSettings(), false);
    expect(root.style.getPropertyValue("--code-font-size")).toBe("14px");

    // m-2 (fix round 1): when the default font itself (JetBrains Mono) fails its check, the notice must not
    // claim to fall back to JetBrains Mono from JetBrains Mono; a distinct message is used instead.
    const defaultStore = hydrated("JetBrains Mono");
    const defaultRoot = document.createElement("div");
    const stopDefault = startAppearanceSync(
      defaultStore,
      defaultRoot,
      mock(async () => false),
    );
    await Bun.sleep(1);
    expect(defaultStore.getState().fontFallback).toBe(true);
    expect(defaultStore.getState().statusMessage).toBe(
      "The bundled code font couldn't load; using the system monospace font.",
    );
    stopDefault();
  });

  test("zoom commands step uiScale through Main", async () => {
    const store = hydrated();
    const { api } = createFakeApi();
    api.updateSettings.mockImplementation(async (patch: unknown) =>
      mergeSettings(defaultSettings(), patch as Parameters<typeof mergeSettings>[1]),
    );
    const commands = new Map(createViewCommands(store, api).map((spec) => [spec.id, spec]));
    await commands.get("view.zoomIn")?.run();
    expect(api.updateSettings).toHaveBeenLastCalledWith({ appearance: { uiScale: 1.1 } });
    await commands.get("view.zoomIn")?.run();
    expect(api.updateSettings).toHaveBeenLastCalledWith({ appearance: { uiScale: 1.25 } });
    await commands.get("view.zoomReset")?.run();
    expect(api.updateSettings).toHaveBeenLastCalledWith({ appearance: { uiScale: 1 } });
  });
});

describe("vim status node", () => {
  // Test A (fix round 1, review I-1): monaco-vim renders its mode indicator and `:`/`/` prompt input into the
  // node Editor.tsx gives it. The brief's node was `.visually-hidden` (1px, clipped), so a focused `:`/`/`
  // input received keystrokes the user could never see. `startVim` needs a real Monaco editor, and importing
  // vim.ts itself (which eagerly requires `monaco-vim`, and through it `monaco-editor/esm/vs/editor/editor.api`)
  // fails outside the Vite build's alias (confirmed: importing vim.ts directly from this test throws "Cannot
  // find module 'monaco-editor/esm/vs/editor/editor.api'"). So the node creation lives in its own module,
  // editor/vim-status.ts, with no monaco-vim dependency, and this test pins that helper instead.
  test("is visible (not `.visually-hidden`), carries `.vim-status`, and is removable", () => {
    const node = createVimStatusNode(null);
    expect(document.body.contains(node)).toBe(true);
    expect(node.classList.contains("vim-status")).toBe(true);
    expect(node.classList.contains("visually-hidden")).toBe(false);
    node.remove();
    expect(document.body.contains(node)).toBe(false);

    // T16-rr1 (replaces fix round 2's hand insertion before `.status-bar`): the node goes into the React-owned
    // `.vim-slot`, which App renders directly before the status bar (`display: contents`, so the node is still a
    // flex child of `.app` and reserves its own row). App-level placement across a status bar remount is covered in
    // app.test.tsx.
    const slot = document.createElement("div");
    slot.className = "vim-slot";
    document.body.appendChild(slot);
    const slotted = createVimStatusNode(slot);
    expect(slotted.parentElement).toBe(slot);
    expect(slotted.classList.contains("visually-hidden")).toBe(false);
    slotted.remove();
    expect(slot.children.length).toBe(0);
    slot.remove();
  });
});

describe("CJK coverage (spec §9.4, §17)", () => {
  test("the stack names CJK families explicitly, after the chosen font and before the generic", () => {
    const stack = fontStack(DEFAULT_FONT);
    expect(stack.startsWith('"JetBrains Mono Variable"')).toBe(true);
    expect(stack).toContain("Hiragino Sans");
    expect(stack).toContain("PingFang SC");
    expect(stack.endsWith("monospace")).toBe(true);
    // The chosen font must still win for Latin text, so the CJK families come after it.
    expect(stack.indexOf("JetBrains Mono Variable")).toBeLessThan(stack.indexOf("Hiragino Sans"));
  });

  test("every bundled font gets the same fallback, since none of the six covers CJK", () => {
    for (const font of ["Fira Code", "Hack", "Ubuntu Mono", "Source Code Pro", "DejaVu Sans Mono"]) {
      expect(fontStack(font)).toContain(CJK_FALLBACK);
    }
  });

  test("a font name containing a quote still produces a well-formed stack", () => {
    expect(fontStack('Ev"il')).not.toContain('""');
  });
});
