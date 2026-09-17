import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { RunEvent } from "@jslab/rpc-schema";
import { createTab, defaultSession, defaultSettings } from "@jslab/shared";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { OutputPanel } from "../src/output/OutputPanel";
import { entryToText } from "../src/output/text";
import type { DisplayEvent } from "../src/state/output";
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

  // R-M2-T19A-1: what the button actually puts on the clipboard, not just whether it is enabled. The test above
  // only ever asserted `disabled`, which is how the button and the `output.copyAll` command were able to copy
  // different sets without any test noticing.
  test("Copy All copies exactly the entries the chip leaves visible (R-M2-T19A-1)", async () => {
    setup();
    const writes: string[] = [];
    const originalClipboard = navigator.clipboard;
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: (text: string) => {
          writes.push(text);
          return Promise.resolve();
        },
      },
      configurable: true,
    });
    try {
      fireEvent.click(screen.getByRole("radio", { name: "Errors 1" }));
      fireEvent.click(button("Copy All"));
      await act(async () => {
        await Bun.sleep(1);
      });
      expect(writes).toEqual([entryToText(error as DisplayEvent)]);
    } finally {
      Object.defineProperty(navigator, "clipboard", { value: originalClipboard, configurable: true });
    }
  });

  // Item 8: the keyboard reaches the same store state the mouse does. EntryRow's own test pins that it reports the
  // line; this pins that the report is actually wired through to the editor's hovered-line decoration, which is
  // what the mouse path has always had.
  test("focusing a row's line badge sets the hovered line, and blurring clears it (item 8)", () => {
    const store = setup();
    const badge = screen.getAllByRole("button", { name: /^L\d+$/ })[0];
    if (!badge) throw new Error("expected at least one line badge");

    act(() => badge.focus());
    expect(store.getState().hoveredLine).toBe(1);

    act(() => badge.blur());
    expect(store.getState().hoveredLine).toBeNull();
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
    // R-UI9-COUNTS-1: the Results chip now always carries its count, and this scenario has zero results
    // (one log event, no results), so its accessible name is "Results 0", not the bare label.
    fireEvent.click(screen.getByRole("radio", { name: "Results 0" }));
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

  /**
   * Audit entry 3: before this, `OutputPanel` and `EntryRow` carried no live region at all -- only `aria-label` and
   * `aria-hidden` -- so with Auto Run on, results appeared with no user action and no announcement whatsoever.
   *
   * What these two tests can prove: the region is in the markup before it has content, it keeps its identity across
   * re-renders (so it is mutated, not replaced), it exposes `role="status"` (implicitly, via `<output>`), and the
   * text that lands in it. What they CANNOT prove: that any screen reader actually speaks it. happy-dom has no
   * accessibility tree and no layout engine, so real AT behaviour is manual QA, asserted nowhere in this file.
   */
  const liveRegion = () => document.querySelector("output.visually-hidden") as HTMLElement | null;

  test("a polite live region exists before it has anything to say, and is mutated rather than replaced", () => {
    const store = createAppStore();
    store.getState().hydrate({
      settings: defaultSettings(),
      session: defaultSession(() => createTab({ id: "t1" })),
      buffers: { t1: "" },
      safeMode: { active: false, reason: null },
      versions: { app: "0", bun: "1.4.0" },
    });
    const { api } = createFakeApi();
    render(<OutputPanel store={store} api={api} />);

    const region = liveRegion();
    expect(region).toBeTruthy();
    expect(region?.tagName).toBe("OUTPUT");
    // `<output>`'s implicit role is `status`, which is `aria-live="polite"` + `aria-atomic="true"`.
    expect(screen.getByRole("status")).toBe(region as HTMLElement);
    expect(region?.textContent).toBe("");

    act(() => {
      store.getState().receiveState("r1", "transpiling", undefined, "t1");
      store.getState().receiveEvents("r1", [result, log(2, 2), error], "t1");
    });
    // Still silent while the run is in flight: the summary belongs to the outcome, not to each arriving row.
    expect(liveRegion()?.textContent).toBe("");

    act(() => store.getState().receiveState("r1", "idle", 0, "t1"));
    expect(liveRegion()?.textContent).toBe(strings.output.announce.runFinished(3, 1));
    // The same DOM node throughout. A live region that is torn down and rebuilt often announces nothing.
    expect(liveRegion()).toBe(region as HTMLElement);
  });

  test("the region announces a per-run summary, not a row, and blanks between runs", () => {
    const store = setup();
    act(() => store.getState().receiveState("r1", "idle", 0, "t1"));
    expect(liveRegion()?.textContent).toBe(strings.output.announce.runFinished(3, 1));

    // A second run of the same code: the region must blank first, or an identical sentence would be a silent
    // no-op in the DOM. This is the Auto Run case -- results with no user action at all.
    act(() => store.getState().receiveState("r2", "transpiling", undefined, "t1"));
    expect(liveRegion()?.textContent).toBe("");

    act(() => {
      store.getState().receiveState("r2", "evaluating", undefined, "t1");
      store.getState().receiveEvents("r2", [log(1, 1), log(2, 2)], "t1");
    });
    expect(liveRegion()?.textContent).toBe("");

    act(() => store.getState().receiveState("r2", "idle", 0, "t1"));
    // Two log rows, no errors -- a summary of the run, not one announcement per row.
    expect(liveRegion()?.textContent).toBe(strings.output.announce.runFinished(2, 0));
    expect(screen.getAllByTestId("entry").length).toBe(2);
  });
});
