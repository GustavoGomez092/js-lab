import { describe, expect, mock, test } from "bun:test";
import type { RunEvent } from "@jslab/rpc-schema";
import { fireEvent, render, screen } from "@testing-library/react";
import { EntryRow } from "../src/output/EntryRow";
import type { DisplayEvent } from "../src/state/output";

const noExpand = async () => null;

function renderEntry(
  event: RunEvent,
  overrides: { onReveal?: (line: number) => void; onHover?: (line: number | null) => void } = {},
) {
  const onReveal = overrides.onReveal ?? mock(() => {});
  const onHover = overrides.onHover ?? mock(() => {});
  const view = render(
    <EntryRow
      entry={{ key: "k", event: event as DisplayEvent }}
      stale={false}
      expand={noExpand}
      onReveal={onReveal}
      onHover={onHover}
    />,
  );
  return { ...view, onReveal, onHover };
}

describe("EntryRow", () => {
  test("shows the source line badge and reveals the line on click", () => {
    const onReveal = mock((_line: number) => {});
    renderEntry(
      { kind: "result", line: 7, source: "autolog", value: { t: "number", v: "42" }, seq: 1, t: 0 },
      { onReveal },
    );
    fireEvent.click(screen.getByRole("button", { name: "L7" }));
    expect(onReveal).toHaveBeenCalledWith(7);
  });

  test("reports hover so the editor can highlight the line", () => {
    const onHover = mock((_line: number | null) => {});
    renderEntry(
      { kind: "console", level: "log", line: 3, groupDepth: 0, args: [{ t: "string", v: "hi" }], seq: 1, t: 0 },
      { onHover },
    );
    const row = screen.getByTestId("entry");
    fireEvent.mouseEnter(row);
    fireEvent.mouseLeave(row);
    expect(onHover.mock.calls).toEqual([[3], [null]]);
  });

  test("styles console levels and indents groups", () => {
    renderEntry({ kind: "console", level: "warn", groupDepth: 2, args: [{ t: "string", v: "careful" }], seq: 1, t: 0 });
    const row = screen.getByTestId("entry");
    expect(row.className).toContain("entry-console-warn");
    expect(row.style.paddingLeft).toBe("32px");
  });

  test("renders errors with clickable user frames and a count of internal frames", () => {
    const onReveal = mock((_line: number) => {});
    renderEntry(
      {
        kind: "error",
        phase: "unhandledRejection",
        name: "Error",
        message: "nope",
        line: 4,
        stack: [
          { fn: "load", line: 4, column: 9, user: true },
          { fn: "internal", file: "/bun/internal.js", line: 1, column: 1, user: false },
        ],
        seq: 1,
        t: 0,
      },
      { onReveal },
    );
    expect(screen.getByText(/Uncaught \(in promise\) Error: nope/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "at load (L4:9)" }));
    expect(onReveal).toHaveBeenCalledWith(4);
    expect(screen.getByText("1 internal frames")).toBeTruthy();
  });

  test("renders console.table as a table", () => {
    renderEntry({
      kind: "console",
      level: "table",
      groupDepth: 0,
      args: [
        {
          t: "array",
          id: 1,
          ctor: "Array",
          length: 1,
          items: [[0, { t: "object", id: 2, ctor: "Object", props: [[{ k: "name" }, { t: "string", v: "Ada" }]] }]],
        },
      ],
      seq: 1,
      t: 0,
    });
    expect(screen.getByRole("columnheader", { name: "name" })).toBeTruthy();
    expect(screen.getByRole("cell", { name: '"Ada"' })).toBeTruthy();
  });

  test("renders stdout text", () => {
    renderEntry({ kind: "stdout", text: "raw output\n", seq: 1, t: 0 });
    expect(screen.getByText("raw output")).toBeTruthy();
  });
});
