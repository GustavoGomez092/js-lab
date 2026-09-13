import { describe, expect, test } from "bun:test";
import { defaultSettings, mergeSettings, runnerSettings, settingsSchema } from "../src/settings";

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
    expect(s.appearance).toEqual({ theme: "dracula", font: "JetBrains Mono", fontSize: 14 });
  });

  test("repairs invalid fields individually and keeps valid ones", () => {
    const s = settingsSchema.parse({ run: { autoRun: "yes", autoLog: false, autoRunDelayMs: 99_999 } });
    expect(s.run.autoRun).toBe(true);
    expect(s.run.autoLog).toBe(false);
    expect(s.run.autoRunDelayMs).toBe(300);
  });

  test("replaces a whole invalid section with its defaults", () => {
    expect(settingsSchema.parse({ output: "nope" }).output).toEqual({ maxEntries: 10_000, showLineNumbers: true });
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
    });
  });
});
