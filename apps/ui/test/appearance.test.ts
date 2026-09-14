import { describe, expect, mock, test } from "bun:test";
import { createTab, defaultSession, defaultSettings, mergeSettings } from "@jslab/shared";
import { createViewCommands } from "../src/commands/view-commands";
import { editorOptionsFor } from "../src/editor/editor-options";
import { createAppStore } from "../src/state/store";
import { applyAppearanceVariables, fontAvailable, fontStack, startAppearanceSync } from "../src/themes/fonts";
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
      fontFamily: '"JetBrains Mono Variable", ui-monospace, Menlo, monospace',
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
      fontFamily: '"Fira Code", ui-monospace, Menlo, monospace',
      fontSize: 20,
      fontLigatures: false,
      lineNumbers: "off",
      wordWrap: "off",
      autoClosingBrackets: "never",
      renderWhitespace: "all",
      renderLineHighlight: "all",
      hover: { enabled: true, delay: 900 },
    });
    expect(editorOptionsFor(settings, true).fontFamily).toBe(
      '"JetBrains Mono Variable", ui-monospace, Menlo, monospace',
    );
  });
});

describe("fonts", () => {
  test("bundled names map to their web font family; other names are system fonts", () => {
    expect(fontStack("Hack")).toBe('"Hack", ui-monospace, Menlo, monospace');
    expect(fontStack("SF Mono")).toBe('"SF Mono", ui-monospace, Menlo, monospace');
    expect(fontStack('Evil"Font')).toBe('"EvilFont", ui-monospace, Menlo, monospace');
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
