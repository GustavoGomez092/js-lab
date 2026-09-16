import { describe, expect, test } from "bun:test";
import {
  buildSettings,
  defaultSettings,
  effectiveRuntime,
  isRuntimeAvailable,
  mergeSettings,
  nextZoom,
  readSetting,
  runnerSettings,
  settingPatch,
  settingsSchema,
} from "../src/settings";

describe("settings", () => {
  test("defaults match the spec", () => {
    const s = defaultSettings();
    expect(s.run).toMatchObject({
      autoRun: true,
      autoLog: true,
      showUndefined: false,
      loopProtection: true,
      loopProtectionMaxIterations: 2000,
      autoRunDelayMs: 300,
      unresponsiveTimeoutMs: 3000,
      defaultLanguage: "typescript",
      defaultRuntime: "browser-node",
    });
    expect(s.output.maxEntries).toBe(10_000);
    expect(s.appearance).toEqual({
      theme: "graphite",
      followSystem: false,
      lightTheme: "graphite-light",
      darkTheme: "graphite",
      font: "JetBrains Mono",
      fontSize: 14,
      fontLigatures: true,
      uiScale: 1,
    });
  });

  test("repairs invalid fields individually and keeps valid ones", () => {
    const s = settingsSchema.parse({ run: { autoRun: "yes", autoLog: false, autoRunDelayMs: 99_999 } });
    expect(s.run.autoRun).toBe(true);
    expect(s.run.autoLog).toBe(false);
    expect(s.run.autoRunDelayMs).toBe(300);
  });

  test("replaces a whole invalid section with its defaults", () => {
    expect(settingsSchema.parse({ output: "nope" }).output).toEqual({
      maxEntries: 10_000,
      showLineNumbers: true,
      highlighting: true,
    });
  });

  test("preserves unknown keys for forward compatibility", () => {
    const s = settingsSchema.parse({ future: { flag: 1 }, run: { futureRunKey: "x" } }) as Record<string, unknown>;
    expect(s.future).toEqual({ flag: 1 });
    expect((s.run as Record<string, unknown>).futureRunKey).toBe("x");
  });

  test("mergeSettings applies a deep partial and re-validates", () => {
    const merged = mergeSettings(defaultSettings(), { run: { autoRun: false, loopProtectionMaxIterations: -5 } });
    expect(merged.run.autoRun).toBe(false);
    expect(merged.run.loopProtectionMaxIterations).toBe(2000);
    expect(merged.run.autoLog).toBe(true);
  });

  test("runnerSettings extracts what runners need", () => {
    expect(runnerSettings(defaultSettings())).toEqual({
      autoLog: true,
      loopProtection: true,
      loopProtectionMaxIterations: 2000,
      maxEntries: 10_000,
      unresponsiveTimeoutMs: 3000,
      build: buildSettings(defaultSettings()),
    });
  });

  test("the M2 sections match spec §8 defaults", () => {
    const s = defaultSettings();
    expect(s.version).toBe(3);
    expect(s.run.formatOnRun).toBe(false);
    expect(s.tabs).toEqual({ confirmClose: false });
    expect(s.app).toEqual({ uiLanguage: "system" });
    expect(s.editor).toEqual({
      lineNumbers: true,
      lineWrap: true,
      vimKeys: false,
      closeBrackets: true,
      invisibles: false,
      activeLine: false,
      autocomplete: true,
      linting: true,
      hoverInfo: true,
      hoverDelayMs: 400,
      signatures: true,
      formatOnSave: false,
      minimap: false,
    });
    expect(s.prettier).toEqual({
      printWidth: 80,
      tabWidth: 2,
      useTabs: false,
      semi: true,
      singleQuote: false,
      quoteProps: "as-needed",
      jsxSingleQuote: false,
      trailingComma: "all",
      bracketSpacing: true,
      bracketSameLine: false,
      arrowParens: "always",
    });
    expect(s.view).toEqual({
      tabBarForSingleTab: true,
      activityBar: true,
      statusBar: true,
      sideBar: false,
      layout: "horizontal",
    });
    expect(s.updates).toEqual({ auto: true, channel: "stable" });
    expect(settingsSchema.parse({ prettier: { trailingComma: "sometimes", printWidth: 5 } }).prettier).toMatchObject({
      trailingComma: "all",
      printWidth: 80,
    });
  });

  test("zoom steps through fixed levels and resets to 1", () => {
    expect(nextZoom(1, 1)).toBe(1.1);
    expect(nextZoom(1, -1)).toBe(0.9);
    expect(nextZoom(2, 1)).toBe(2);
    expect(nextZoom(0.5, -1)).toBe(0.5);
    expect(nextZoom(1.3, -1)).toBe(1.25);
    expect(nextZoom(1.75, 0)).toBe(1);
  });

  test("every runtime is available now that M4 Task 9 turns the switch on", () => {
    expect(isRuntimeAvailable("bun")).toBe(true);
    expect(isRuntimeAvailable("browser-node")).toBe(true);
    expect(isRuntimeAvailable("browser")).toBe(true);
  });

  test("effectiveRuntime keeps every runtime unchanged; none collapses to bun any more", () => {
    expect(effectiveRuntime("bun")).toBe("bun");
    expect(effectiveRuntime("browser-node")).toBe("browser-node");
    expect(effectiveRuntime("browser")).toBe("browser");
  });

  test("readSetting and settingPatch address a single key", () => {
    expect(readSetting(defaultSettings(), "editor.hoverDelayMs")).toBe(400);
    expect(readSetting(defaultSettings(), "editor.nope")).toBeUndefined();
    expect(settingPatch("view.statusBar", false)).toEqual({ view: { statusBar: false } });
    expect(mergeSettings(defaultSettings(), settingPatch("view.statusBar", false)).view.statusBar).toBe(false);
  });

  test("v3 adds the NPM and Build sections with the spec §8 defaults", () => {
    const s = defaultSettings();
    expect(s.npm).toEqual({ allowInstallScripts: false, autoInstallTypes: false });
    expect(s.build).toEqual({
      decorators: "2023-11",
      pipelineOperator: false,
      doExpressions: false,
      throwExpressions: false,
      functionSent: false,
      regexpModifiers: true,
      optionalChainingAssign: true,
    });
    expect(settingsSchema.parse({ build: { decorators: "stage-1" } }).build.decorators).toBe("2023-11");
    expect(runnerSettings(s).build).toEqual(buildSettings(s));
  });
});
