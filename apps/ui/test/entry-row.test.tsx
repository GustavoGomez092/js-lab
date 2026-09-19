import { describe, expect, mock, test } from "bun:test";
import type { RunEvent } from "@jslab/rpc-schema";
import { fireEvent, render, screen } from "@testing-library/react";
import { EntryRow } from "../src/output/EntryRow";
import type { DisplayEvent } from "../src/state/output";
import { strings } from "../src/strings";

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

  // Item 8, pointer/keyboard parity. The mouse path is already covered by the test above, so this pins only what
  // was missing: a keyboard user tabbing to a row's line badge got no indication of which editor line the row
  // belongs to -- on the app's signature feature, line-anchored output. Driven with a real focus()/blur() rather
  // than a synthetic event, because "can a keyboard actually reach it" is the whole question.
  test("focusing the line badge reports its line, and blurring clears it (item 8)", () => {
    const onHover = mock((_line: number | null) => {});
    renderEntry(
      { kind: "console", level: "log", line: 8, groupDepth: 0, args: [{ t: "string", v: "hi" }], seq: 1, t: 0 },
      { onHover },
    );
    const badge = screen.getByRole("button", { name: "L8" });
    badge.focus();
    expect(document.activeElement).toBe(badge);
    badge.blur();
    expect(onHover.mock.calls).toEqual([[8], [null]]);
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
    fireEvent.click(screen.getByRole("button", { name: strings.output.frame("load", 4, 9) }));
    expect(onReveal).toHaveBeenCalledWith(4);
    expect(screen.getByText(strings.output.internalFrames(1))).toBeTruthy();
  });

  // RR2-m5: the stack-frame label lives in strings.ts, including the anonymous-function fallback.
  test("an anonymous stack frame uses the shared anonymous-function string", () => {
    renderEntry({
      kind: "error",
      phase: "runtime",
      name: "Error",
      message: "boom",
      line: 1,
      stack: [{ line: 1, column: 1, user: true }],
      seq: 1,
      t: 0,
    });
    expect(screen.getByRole("button", { name: strings.output.frame(strings.output.anonymous, 1, 1) })).toBeTruthy();
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

  test("rows carry a level stripe, only errors are tinted, and anchors can be hidden", () => {
    const { unmount } = renderEntry({
      kind: "result",
      line: 5,
      source: "autolog",
      value: { t: "number", v: "1" },
      seq: 1,
      t: 0,
    });
    const row = screen.getByTestId("entry");
    expect(row.className).toContain("entry-level-result");
    expect(row.querySelector(".entry-stripe")).not.toBeNull();
    expect(screen.getByRole("button", { name: "L5" }).textContent).toBe(":5");
    unmount();
    render(
      <EntryRow
        entry={{ key: "k", event: { kind: "stderr", text: "boom", seq: 1, t: 0 } as DisplayEvent }}
        stale={false}
        expand={noExpand}
        onReveal={() => {}}
        onHover={() => {}}
        showLineNumbers={false}
      />,
    );
    expect(screen.getByTestId("entry").className).toContain("entry-level-error");
    expect(screen.queryByRole("button", { name: /^L\d/ })).toBeNull();
  });

  test("a module-not-found runtime error offers to install the package (spec §6.3)", () => {
    const onInstall = mock((_name: string) => {});
    render(
      <EntryRow
        entry={{
          key: "e",
          event: {
            kind: "error",
            phase: "runtime",
            name: "ResolveMessage",
            message: "Cannot find package 'zod' from '/data/runs/t1/entry-1.mjs'",
            stack: [],
            seq: 1,
            t: 0,
          } as DisplayEvent,
        }}
        stale={false}
        expand={noExpand}
        onReveal={() => {}}
        onHover={() => {}}
        onInstall={onInstall}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: strings.output.installPackage("zod") }));
    expect(onInstall).toHaveBeenCalledWith("zod");
  });

  test("a missing working directory offers Change… (spec §12.2)", () => {
    const onChange = mock(() => {});
    render(
      <EntryRow
        entry={{
          key: "wd",
          event: {
            kind: "error",
            phase: "runner",
            name: "WorkingDirectoryError",
            message: "Working directory not found: /gone",
            stack: [],
            seq: 1,
            t: 0,
          } as DisplayEvent,
        }}
        stale={false}
        expand={noExpand}
        onReveal={() => {}}
        onHover={() => {}}
        onChangeWorkingDirectory={onChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: strings.output.changeWorkingDirectory }));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  // OU-10. The menu itself is the tab bar's `ContextMenu`, which has its own tests; these pin what this row
  // contributes -- that the menu exists on an output row, what is on it, what each item copies, and that a
  // keyboard can reach it.
  describe("entry menu (OU-10)", () => {
    const stubClipboard = () => {
      const writes: string[] = [];
      const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
      Object.defineProperty(navigator, "clipboard", {
        value: {
          writeText: (text: string) => {
            writes.push(text);
            return Promise.resolve();
          },
        },
        configurable: true,
      });
      const restore = () => {
        if (original) Object.defineProperty(navigator, "clipboard", original);
        else Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
      };
      return { writes, restore };
    };

    // A string, deliberately: for a number the two menu items would put identical text on the clipboard, so the
    // assertion below could not tell them apart and would survive both items being wired to the same copy.
    const resultRow = { kind: "result", line: 1, source: "autolog", value: { t: "string", v: "hi" }, seq: 1, t: 0 };

    // Literal labels, deliberately: an expectation written as `strings.output.copyEntry` would still pass if the
    // catalogue entry were changed to the wrong words, because the implementation reads that same entry.
    test("right-clicking a row opens a menu offering Copy and Copy as JSON", () => {
      renderEntry(resultRow as RunEvent);
      fireEvent.contextMenu(screen.getByTestId("entry"), { clientX: 5, clientY: 6 });
      expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Copy", "Copy as JSON"]);
    });

    test("Copy puts the row's text on the clipboard, Copy as JSON its value as JSON", async () => {
      const { writes, restore } = stubClipboard();
      try {
        renderEntry(resultRow as RunEvent);
        fireEvent.contextMenu(screen.getByTestId("entry"), { clientX: 5, clientY: 6 });
        fireEvent.click(screen.getByRole("menuitem", { name: "Copy" }));
        await Bun.sleep(1);
        fireEvent.contextMenu(screen.getByTestId("entry"), { clientX: 5, clientY: 6 });
        fireEvent.click(screen.getByRole("menuitem", { name: "Copy as JSON" }));
        await Bun.sleep(1);
        // Bare text, then JSON -- the quotes are the whole difference between the two menu items.
        expect(writes).toEqual(["hi", '"hi"']);
      } finally {
        restore();
      }
    });

    test("a console row copies its arguments as a JSON list, not as joined text", async () => {
      const { writes, restore } = stubClipboard();
      try {
        renderEntry({
          kind: "console",
          level: "log",
          line: 3,
          groupDepth: 0,
          args: [
            { t: "string", v: "hi" },
            { t: "number", v: "2" },
          ],
          seq: 1,
          t: 0,
        } as RunEvent);
        fireEvent.contextMenu(screen.getByTestId("entry"), { clientX: 1, clientY: 1 });
        fireEvent.click(screen.getByRole("menuitem", { name: "Copy as JSON" }));
        await Bun.sleep(1);
        expect(writes).toEqual(['[\n  "hi",\n  2\n]']);
      } finally {
        restore();
      }
    });

    test("a failed clipboard write is reported rather than thrown", async () => {
      const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText: () => Promise.reject(new Error("denied")) },
        configurable: true,
      });
      const onCopyStatus = mock((_status: "copied" | "failed") => {});
      try {
        render(
          <EntryRow
            entry={{ key: "k", event: resultRow as DisplayEvent }}
            stale={false}
            expand={noExpand}
            onReveal={() => {}}
            onHover={() => {}}
            onCopyStatus={onCopyStatus}
          />,
        );
        fireEvent.contextMenu(screen.getByTestId("entry"), { clientX: 1, clientY: 1 });
        fireEvent.click(screen.getByRole("menuitem", { name: "Copy" }));
        await Bun.sleep(1);
        expect(onCopyStatus.mock.calls).toEqual([["failed"]]);
      } finally {
        if (original) Object.defineProperty(navigator, "clipboard", original);
      }
    });

    // The accessibility requirement, and the reason the row carries a button at all: a stdout row has no line
    // badge, so without this control it holds nothing a keyboard can reach.
    test("the menu opens from the keyboard on a row that has no line badge, and focus returns on close", () => {
      renderEntry({ kind: "stdout", text: "raw output\n", seq: 1, t: 0 } as RunEvent);
      expect(screen.queryByRole("button", { name: /^L\d/ })).toBeNull();
      const opener = screen.getByRole("button", { name: "Entry actions" });
      opener.focus();
      expect(document.activeElement).toBe(opener);
      expect(opener.getAttribute("aria-expanded")).toBe("false");

      fireEvent.click(opener);
      expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Copy", "Copy as JSON"]);
      expect(opener.getAttribute("aria-expanded")).toBe("true");
      expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Copy" }));

      fireEvent.keyDown(document, { key: "Escape" });
      expect(screen.queryAllByRole("menuitem")).toEqual([]);
      expect(document.activeElement).toBe(opener);
    });

    test("Shift+F10 on the row opens the menu", () => {
      renderEntry(resultRow as RunEvent);
      fireEvent.keyDown(screen.getByTestId("entry"), { key: "F10", shiftKey: true });
      expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Copy", "Copy as JSON"]);
    });

    test("an unmodified F10 does not open the menu", () => {
      renderEntry(resultRow as RunEvent);
      fireEvent.keyDown(screen.getByTestId("entry"), { key: "F10" });
      expect(screen.queryAllByRole("menuitem")).toEqual([]);
    });
  });

  // R24-4: a relative module-not-found row offers to set a working directory when the tab has none.
  test("a relative module-not-found row offers Set Working Directory… when the tab has no working directory", () => {
    const onChange = mock(() => {});
    render(
      <EntryRow
        entry={{
          key: "e",
          event: {
            kind: "error",
            phase: "runtime",
            name: "ResolveMessage",
            message: "Cannot find module './util' from '/data/runs/t1/entry-1.mjs'",
            stack: [],
            seq: 1,
            t: 0,
          } as DisplayEvent,
        }}
        stale={false}
        expand={noExpand}
        onReveal={() => {}}
        onHover={() => {}}
        onChangeWorkingDirectory={onChange}
        hasWorkingDirectory={false}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: strings.output.setWorkingDirectory }));
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
