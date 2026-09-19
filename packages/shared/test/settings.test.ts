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
      // M4 Task 9a pointed this back at "bun": with the browser runtimes registered, a default tab would route to
      // a web view that starts evaluating and never reports a result. It returns to a browser runtime once runs
      // finish there (packages/shared/src/settings.ts).
      defaultRuntime: "bun",
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
    // The literal, not SETTINGS_VERSION: comparing the constant to a value derived from it asserts nothing.
    // TL-18 took this to 4 by adding the `ai` section.
    expect(s.version).toBe(4);
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

  /**
   * A key whose FIELD contains a dot -- `ai.model.ollama` is the field `model.ollama` of section `ai` (spec §8).
   *
   * `key.split(".")` destructured as `[section, field]` yields the field `model`, which no section holds: the
   * read returns undefined and the patch writes the wrong key, dropping the provider entirely. Both helpers
   * therefore split at the FIRST dot only, and both directions are pinned here because they fail differently --
   * the read shows a blank field, the patch silently saves nothing.
   */
  test("a setting key whose field contains a dot addresses the right field (ai.model.<provider>)", () => {
    const s = defaultSettings();
    expect(readSetting(s, "ai.model.ollama")).toBe("");
    expect(settingPatch("ai.model.ollama", "mistral:latest")).toEqual({ ai: { "model.ollama": "mistral:latest" } });

    const updated = mergeSettings(s, settingPatch("ai.model.ollama", "mistral:latest"));
    expect(readSetting(updated, "ai.model.ollama")).toBe("mistral:latest");
    // The neighbouring key must not have been written instead, which is exactly what the old split did.
    expect(readSetting(updated, "ai.baseUrl.ollama")).toBe("");
    expect((updated.ai as Record<string, unknown>).model).toBeUndefined();

    // Single-dot keys keep behaving exactly as before.
    expect(settingPatch("view.statusBar", true)).toEqual({ view: { statusBar: true } });
  });

  test("the ai section carries the spec §8 defaults, and repairs a bad provider", () => {
    const s = defaultSettings();
    expect(s.ai).toEqual({
      provider: "none",
      "model.ollama": "",
      "baseUrl.ollama": "",
      includeOutput: true,
    });
    // Blank is a real value here -- it is how "use the default" is expressed -- so it must survive a round trip
    // rather than being repaired back to a fallback the way `text()` fields are.
    expect(settingsSchema.parse({ ai: { "baseUrl.ollama": "" } }).ai["baseUrl.ollama"]).toBe("");
    expect(settingsSchema.parse({ ai: { provider: "nonesuch" } }).ai.provider).toBe("none");
    // Every provider in the seam is ACCEPTED on disk, so a value written by a later build survives a downgrade.
    expect(settingsSchema.parse({ ai: { provider: "anthropic" } }).ai.provider).toBe("anthropic");
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
