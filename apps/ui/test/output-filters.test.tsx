import { describe, expect, mock, test } from "bun:test";
import type { RunEvent } from "@jslab/rpc-schema";
import { fireEvent, render, screen } from "@testing-library/react";
import { FilterChips } from "../src/output/FilterChips";
import { applyFilter, entryLevel, filterCounts } from "../src/output/filters";
import { entryIsStale, lastSuccessfulRunLabel } from "../src/output/stale";
import { applyRunEvents, applyRunState, type DisplayEvent, initialOutput, type OutputEntry } from "../src/state/output";

const entry = (event: RunEvent, key: string): OutputEntry => ({ key, event: event as DisplayEvent });
const consoleEvent = (level: "log" | "warn" | "error" | "assert" | "info", seq: number): RunEvent => ({
  kind: "console",
  level,
  groupDepth: 0,
  args: [],
  seq,
  t: 0,
});

const entries = [
  entry({ kind: "result", line: 1, source: "autolog", value: { t: "number", v: "1" }, seq: 1, t: 0 }, "a"),
  entry(consoleEvent("log", 2), "b"),
  entry(consoleEvent("warn", 3), "c"),
  entry(consoleEvent("error", 4), "d"),
  entry({ kind: "stdout", text: "out", seq: 5, t: 0 }, "e"),
  entry({ kind: "stderr", text: "err", seq: 6, t: 0 }, "f"),
  entry({ kind: "error", phase: "runtime", name: "Error", message: "x", stack: [], seq: 7, t: 0 }, "g"),
  entry(consoleEvent("assert", 8), "h"),
];

describe("output filters", () => {
  test("levels, counts and filtering", () => {
    expect(entries.map((e) => entryLevel(e.event))).toEqual([
      "result",
      "log",
      "warn",
      "error",
      "log",
      "error",
      "error",
      "error",
    ]);
    expect(filterCounts(entries)).toEqual({ all: 8, results: 1, logs: 3, errors: 4 });
    expect(applyFilter(entries, "logs").map((e) => e.key)).toEqual(["b", "c", "e"]);
    expect(applyFilter(entries, "all")).toBe(entries);
  });

  test("all four chips show their count (R-UI9-COUNTS-1) and report the chosen filter", () => {
    const onChange = mock((_filter: string) => {});
    render(<FilterChips counts={{ all: 8, results: 1, logs: 3, errors: 4 }} filter="all" onChange={onChange} />);
    expect(screen.getAllByRole("radio").map((chip) => chip.textContent)).toEqual([
      "All 8",
      "Results 1",
      "Logs 3",
      "Errors 4",
    ]);
    expect(screen.getByRole("radio", { name: "All 8" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("radio", { name: "Errors 4" }));
    expect(onChange).toHaveBeenCalledWith("errors");
  });

  test("a zero count still renders as a fact, not a bare label", () => {
    render(<FilterChips counts={{ all: 3, results: 0, logs: 3, errors: 0 }} filter="all" onChange={() => {}} />);
    expect(screen.getAllByRole("radio").map((chip) => chip.textContent)).toEqual([
      "All 3",
      "Results 0",
      "Logs 3",
      "Errors 0",
    ]);
  });

  test("chip counts track the actual entry set through filterCounts, not a static prop", () => {
    // Drives FilterChips through the real `filterCounts` lookup (not a hand-picked counts object) so a mutant
    // that makes the count lookup return a constant is caught here: shrinking the entry set from 8 down to 3
    // would leave every chip showing the first set's counts.
    const { rerender } = render(<FilterChips counts={filterCounts(entries)} filter="all" onChange={() => {}} />);
    expect(screen.getAllByRole("radio").map((chip) => chip.textContent)).toEqual([
      "All 8",
      "Results 1",
      "Logs 3",
      "Errors 4",
    ]);

    const shrunk = entries.slice(0, 3); // result, log, warn -> all: 3, results: 1, logs: 2, errors: 0
    rerender(<FilterChips counts={filterCounts(shrunk)} filter="all" onChange={() => {}} />);
    expect(screen.getAllByRole("radio").map((chip) => chip.textContent)).toEqual([
      "All 3",
      "Results 1",
      "Logs 2",
      "Errors 0",
    ]);
  });

  test("a chip's accessible name includes its count, for assistive tech (matches e2519c9, 4f07b84)", () => {
    render(<FilterChips counts={{ all: 8, results: 1, logs: 3, errors: 4 }} filter="all" onChange={() => {}} />);
    // getByRole with `name` matches the accessible name -- for these buttons that's their text content, so
    // this assertion fails if the count is ever dropped from the label or moved into a sibling node the
    // accessible-name computation does not reach.
    for (const name of ["All 8", "Results 1", "Logs 3", "Errors 4"]) {
      expect(screen.getByRole("radio", { name })).toBeTruthy();
    }
  });

  test("a failed compile labels the kept output as the last successful run, and only that output is dimmed (spec §5.11)", () => {
    const result: RunEvent = {
      kind: "result",
      line: 1,
      source: "autolog",
      value: { t: "number", v: "1" },
      seq: 1,
      t: 0,
    };
    const syntax: RunEvent = {
      kind: "error",
      phase: "transpile",
      name: "SyntaxError",
      message: "Unexpected token",
      line: 1,
      column: 7,
      stack: [],
      seq: 1,
      t: 0,
    };
    let output = applyRunState(initialOutput, "r1", "transpiling");
    output = applyRunEvents(output, "r1", [result]);
    output = applyRunState(output, "r1", "idle");
    expect(lastSuccessfulRunLabel(output)).toBeNull();
    output = applyRunState(output, "r2", "transpiling");
    output = applyRunEvents(output, "r2", [syntax]);
    output = applyRunState(output, "r2", "failed");
    expect(lastSuccessfulRunLabel(output)).toBe("Last successful run");
    expect(output.entries.map((entry) => entryIsStale(output, entry.event))).toEqual([true, false]);
  });
});
