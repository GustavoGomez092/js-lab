import { describe, expect, test } from "bun:test";
import { createTab, defaultSettings, mergeSettings } from "@jslab/shared";
import { tsStateFor } from "../src/editor/ts-state";

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
