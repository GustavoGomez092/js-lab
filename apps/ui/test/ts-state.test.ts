import { describe, expect, test } from "bun:test";
import { createTab, defaultSettings, mergeSettings, normalizeSession, sessionSchema } from "@jslab/shared";
import { tsEnvironmentChanged, tsStateFor } from "../src/editor/ts-state";
import { createAppStore } from "../src/state/store";

describe("tsStateFor", () => {
  test("describes the shown tab's runtime, decorators and linting, or null without a tab or settings", () => {
    const settings = mergeSettings(defaultSettings(), { build: { decorators: "legacy" }, editor: { linting: false } });
    const tabs = { a: createTab({ id: "a", runtime: "bun" }) };
    expect(tsStateFor({ activeTabId: "a", tabs, settings })).toEqual({
      tabId: "a",
      runtime: "bun",
      decorators: "legacy",
      linting: false,
    });
    expect(tsStateFor({ activeTabId: null, tabs, settings })).toBeNull();
    expect(tsStateFor({ activeTabId: "a", tabs, settings: null })).toBeNull();
  });
});

describe("tsEnvironmentChanged", () => {
  test("is true when the shown tab's runtime, decorators or linting change", () => {
    const settings = mergeSettings(defaultSettings(), { build: { decorators: "legacy" }, editor: { linting: true } });
    const tabs = { a: createTab({ id: "a", runtime: "bun" }) };
    const base = { activeTabId: "a", tabs, settings };

    const runtimeChanged = { ...base, tabs: { a: createTab({ id: "a", runtime: "browser" }) } };
    expect(tsEnvironmentChanged(runtimeChanged, base)).toBe(true);

    const decoratorsChanged = { ...base, settings: mergeSettings(settings, { build: { decorators: "2023-11" } }) };
    expect(tsEnvironmentChanged(decoratorsChanged, base)).toBe(true);

    const lintingChanged = { ...base, settings: mergeSettings(settings, { editor: { linting: false } }) };
    expect(tsEnvironmentChanged(lintingChanged, base)).toBe(true);
  });

  test("ignores buffer edits and switches between tabs with the same environment", () => {
    const store = createAppStore();
    store.getState().hydrate({
      settings: defaultSettings(),
      session: normalizeSession(
        sessionSchema.parse({
          tabOrder: ["a", "b"],
          activeTabId: "a",
          tabs: { a: createTab({ id: "a", runtime: "bun" }), b: createTab({ id: "b", runtime: "bun" }) },
        }),
      ),
      buffers: { a: "const a = 1", b: "const b = 2" },
      safeMode: { active: false, reason: null },
      versions: { app: "0", bun: "1.4.0" },
    });

    // Only buffers[activeTabId] changes.
    const beforeEdit = store.getState();
    store.getState().editCode("const a = 2", "a");
    expect(tsEnvironmentChanged(store.getState(), beforeEdit)).toBe(false);

    // activeTabId moves to another tab with the same runtime, settings unchanged.
    const beforeSwitch = store.getState();
    store.getState().activateTab("b");
    expect(tsEnvironmentChanged(store.getState(), beforeSwitch)).toBe(false);
  });
});
