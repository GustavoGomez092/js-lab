import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { RunEvent } from "@jslab/rpc-schema";
import { createTab, defaultSession, defaultSettings } from "@jslab/shared";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { OutputPanel } from "../src/output/OutputPanel";
import { createAppStore } from "../src/state/store";
import { createFakeApi } from "./fake-api";

const result: RunEvent = { kind: "result", line: 1, source: "autolog", value: { t: "number", v: "2" }, seq: 1, t: 0 };
const log = (line: number, seq: number): RunEvent => ({
  kind: "console",
  level: "log",
  line,
  groupDepth: 0,
  args: [{ t: "string", v: "hi" }],
  seq,
  t: 0,
});
const error: RunEvent = {
  kind: "error",
  phase: "runtime",
  name: "TypeError",
  message: "boom",
  line: 3,
  column: 1,
  stack: [],
  seq: 3,
  t: 0,
};

function setup() {
  const store = createAppStore();
  store.getState().hydrate({
    settings: defaultSettings(),
    session: defaultSession(() => createTab({ id: "t1" })),
    buffers: { t1: "" },
    safeMode: { active: false, reason: null },
    versions: { app: "0", bun: "1.4.0" },
  });
  act(() => {
    store.getState().receiveState("r1", "transpiling", undefined, "t1");
    store.getState().receiveEvents("r1", [result, log(2, 2), error], "t1");
  });
  const { api } = createFakeApi();
  render(<OutputPanel store={store} api={api} />);
  return store;
}

const rowLevels = () =>
  screen.queryAllByTestId("entry").map((row) => /entry-level-(\w+)/.exec(row.className)?.[1] ?? row.className);
const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;

describe("OutputPanel", () => {
  // @tanstack/virtual-core sizes the scroll element from offsetWidth/offsetHeight, which happy-dom reports as 0, so
  // the virtualizer would render no rows. Give only the output scroller a size; every other element is unchanged.
  const SIZES = { offsetHeight: 600, offsetWidth: 400 } as const;
  const originals = new Map<keyof typeof SIZES, PropertyDescriptor | undefined>();
  beforeEach(() => {
    for (const [prop, size] of Object.entries(SIZES) as [keyof typeof SIZES, number][]) {
      const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop);
      originals.set(prop, original);
      Object.defineProperty(HTMLElement.prototype, prop, {
        configurable: true,
        get(this: HTMLElement) {
          return this.classList.contains("output-scroller") ? size : (original?.get?.call(this) ?? 0);
        },
      });
    }
  });
  afterEach(() => {
    for (const [prop, original] of originals) {
      if (original) Object.defineProperty(HTMLElement.prototype, prop, original);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[prop];
    }
    originals.clear();
  });

  test("chips narrow the rendered rows, hovering a row sets the hovered line, and Copy All follows the filtered list", () => {
    const store = setup();
    expect(rowLevels()).toEqual(["result", "log", "error"]);

    fireEvent.click(screen.getByRole("radio", { name: "Errors 1" }));
    expect(rowLevels()).toEqual(["error"]);

    const [row] = screen.getAllByTestId("entry");
    fireEvent.mouseEnter(row as HTMLElement);
    expect(store.getState().hoveredLine).toBe(3);
    fireEvent.mouseLeave(row as HTMLElement);
    expect(store.getState().hoveredLine).toBeNull();

    fireEvent.click(button("Clear"));
    expect([button("Copy All").disabled, button("Clear").disabled]).toEqual([true, true]);

    // A log arrives while the Errors filter is on: nothing to copy, but there is output to clear.
    act(() => store.getState().receiveEvents("r1", [log(4, 4)], "t1"));
    expect(rowLevels()).toEqual([]);
    expect([button("Copy All").disabled, button("Clear").disabled]).toEqual([true, false]);
  });
});
