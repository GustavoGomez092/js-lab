import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { RunEvent } from "@jslab/rpc-schema";
import { createTab, defaultSession, defaultSettings } from "@jslab/shared";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { OutputPanel } from "../src/output/OutputPanel";
import { createAppStore } from "../src/state/store";
import { strings } from "../src/strings";
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

  // T19A-m3 / review rec 2: a filter that hides everything, and a tab that hasn't run, say so instead of a blank
  // scroller.
  test("a zero-match filter offers Show all, and a tab with no output yet says how to run (T19A-m3)", () => {
    const store = setup();
    expect(screen.queryByTestId("output-empty")).toBeNull();
    act(() => {
      store.getState().clearOutput("t1");
      store.getState().receiveEvents("r1", [log(5, 5)], "t1");
    });
    fireEvent.click(screen.getByRole("radio", { name: "Results" }));
    expect(rowLevels()).toEqual([]);
    expect(screen.getByTestId("output-empty").textContent).toContain(strings.output.noMatches);
    fireEvent.click(screen.getByRole("button", { name: strings.output.showAll }));
    expect([store.getState().outputFilter, rowLevels()]).toEqual(["all", ["log"]]);
    expect(screen.queryByTestId("output-empty")).toBeNull();
  });

  test("a tab with no output yet says to press the Run chord", () => {
    const store = createAppStore();
    store.getState().hydrate({
      settings: defaultSettings(),
      session: defaultSession(() => createTab({ id: "t1" })),
      buffers: { t1: "" },
      safeMode: { active: false, reason: null },
      versions: { app: "0", bun: "1.4.0" },
    });
    const { api } = createFakeApi();
    render(<OutputPanel store={store} api={api} runKeys="⌃↩" />);
    expect(screen.getByTestId("output-empty").textContent).toBe(strings.output.noOutput("⌃↩"));
    act(() => {
      store.getState().receiveState("r1", "transpiling", undefined, "t1");
      store.getState().receiveEvents("r1", [log(1, 1)], "t1");
    });
    expect(screen.queryByTestId("output-empty")).toBeNull();
  });

  // Task 23 fix round 2, N-2: pins the R23-1 routing from the output row's own button, not just the command itself.
  test("the output row's Install button calls onInstall with the package", () => {
    const store = createAppStore();
    store.getState().hydrate({
      settings: defaultSettings(),
      session: defaultSession(() => createTab({ id: "t1" })),
      buffers: { t1: "" },
      safeMode: { active: false, reason: null },
      versions: { app: "0", bun: "1.4.0" },
    });
    const missingPackage: RunEvent = {
      kind: "error",
      phase: "runtime",
      name: "ResolveMessage",
      message: "Cannot find package 'zod' from '/data/runs/t1/entry-1.mjs'",
      stack: [],
      seq: 1,
      t: 0,
    };
    act(() => {
      store.getState().receiveState("r1", "transpiling", undefined, "t1");
      store.getState().receiveEvents("r1", [missingPackage], "t1");
    });
    const { api } = createFakeApi();
    const onInstall = mock((_spec: string) => {});
    render(<OutputPanel store={store} api={api} onInstall={onInstall} />);
    fireEvent.click(button(strings.output.installPackage("zod")));
    expect(onInstall).toHaveBeenCalledTimes(1);
    expect(onInstall).toHaveBeenCalledWith("zod");
  });

  // OU-02 Task C: the only thing pinning the offset's last hop. `ValueView` can compute the right offset and
  // still have it dropped here, which the user would see as "… more entries" returning page one forever. Kept
  // inside this describe so the beforeEach that patches offsetHeight/offsetWidth applies -- without it the
  // virtualizer renders zero rows and the test would pass vacuously.
  test("the more-entries button carries the offset to run.expand (OU-02)", async () => {
    const paged: RunEvent = {
      kind: "result",
      line: 1,
      source: "autolog",
      seq: 1,
      t: 0,
      value: {
        t: "array",
        id: 1,
        ctor: "Array",
        length: 5,
        items: [[0, { t: "number", v: "0" }]],
        more: 4,
        next: 1,
        handle: "h1",
      },
    };
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
      store.getState().receiveEvents("r1", [paged], "t1");
    });
    // The file's own `setup()` discards the api it builds, so this test keeps its own.
    const { api } = createFakeApi();
    render(<OutputPanel store={store} api={api} />);

    fireEvent.click(screen.getByRole("button", { name: /Array\(5\)/ }));
    // `loadMore` settles its loading and page state on the microtask after the click, so the click is awaited
    // inside act(...); otherwise that update escapes the test and React warns.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /more entries/ }));
    });
    expect(api.expand).toHaveBeenLastCalledWith({ tabId: "t1", runId: "r1", handleId: "h1", offset: 1 });
  });
});
