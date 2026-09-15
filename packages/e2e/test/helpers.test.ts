import { describe, expect, test } from "bun:test";
import { type E2EState, newActiveTabId } from "../src/helpers";
import { processTree } from "../src/process";

const snapshot = (tabOrder: string[], activeTabId: string): E2EState => ({
  ui: { ready: true, safeMode: { active: false, reason: null }, activeTabId, tabOrder, tabs: [], settings: null },
  main: {},
});

describe("harness helpers", () => {
  test("processTree walks children from the spawned pid only, parents first, and survives cycles", () => {
    const children: Record<number, number[]> = { 10: [11, 12], 11: [13], 12: [], 13: [11], 99: [100] };
    expect(processTree(10, (pid) => children[pid] ?? [])).toEqual([10, 11, 12, 13]);
  });

  test("newActiveTabId answers only once exactly one new tab exists and it is active", () => {
    expect(newActiveTabId(["a"], snapshot(["a"], "a"))).toBeNull();
    expect(newActiveTabId(["a"], snapshot(["a", "b"], "a"))).toBeNull();
    expect(newActiveTabId(["a"], snapshot(["a", "b"], "b"))).toBe("b");
    expect(newActiveTabId(["a"], snapshot(["a", "b", "c"], "c"))).toBeNull();
  });
});
