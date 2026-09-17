import { describe, expect, mock, spyOn, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { SplitPane } from "../src/shell/SplitPane";
import { strings } from "../src/strings";

describe("SplitPane", () => {
  test("removes drag listeners when unmounted mid-drag, or when the second pane is hidden mid-drag", () => {
    const removeEventListener = spyOn(window, "removeEventListener");
    try {
      const { unmount } = render(
        <SplitPane
          orientation="horizontal"
          label="Editor and Output"
          size={50}
          secondVisible
          onResize={() => {}}
          onReset={() => {}}
          first={<div />}
          second={<div />}
        />,
      );

      // Start a drag: this registers window-level pointermove/pointerup listeners that only `up()` used to remove.
      fireEvent.pointerDown(screen.getByRole("separator"));

      // Unmount mid-drag, before the user ever releases the pointer.
      unmount();

      const removedTypes = removeEventListener.mock.calls.map((call) => call[0]);
      expect(removedTypes).toContain("pointermove");
      expect(removedTypes).toContain("pointerup");
    } finally {
      removeEventListener.mockRestore();
    }

    // Fix round 1 (review m-5): hiding the second pane (e.g. view.toggleOutput) mid-drag removes the divider
    // from the DOM, but a window-level pointermove/pointerup from the drag that was in flight must not survive
    // it -- otherwise releasing the pointer afterwards still calls onResize with a stale ratio.
    const onResize = mock(() => {});
    const { rerender } = render(
      <SplitPane
        orientation="horizontal"
        label="Editor and Output"
        size={50}
        secondVisible
        onResize={onResize}
        onReset={() => {}}
        first={<div />}
        second={<div />}
      />,
    );
    fireEvent.pointerDown(screen.getByRole("separator"));
    rerender(
      <SplitPane
        orientation="horizontal"
        label="Editor and Output"
        size={50}
        secondVisible={false}
        onResize={onResize}
        onReset={() => {}}
        first={<div />}
        second={<div />}
      />,
    );
    fireEvent.pointerMove(window);
    expect(onResize).not.toHaveBeenCalled();
  });

  /**
   * The defect this pins: two `role="separator"` elements with no accessible names, announced identically as
   * "separator, <value>", so a screen reader user cannot tell which splitter they are on.
   *
   * SCOPE, stated plainly: happy-dom has no accessibility tree and no layout engine. These assertions pin the
   * attribute, its value, and that Testing Library's role+name query resolves it. They do NOT and cannot prove
   * that any screen reader announces the name -- no test in this repo can.
   */
  test("the separator carries its label as its accessible name, and the two production names are distinct", () => {
    render(
      <SplitPane
        orientation="horizontal"
        label={strings.shell.splitter.editorOutput}
        size={50}
        secondVisible
        onResize={() => {}}
        onReset={() => {}}
        first={<div />}
        second={<div />}
      />,
    );

    const separator = screen.getByRole("separator");
    expect(separator.getAttribute("aria-label")).toBe(strings.shell.splitter.editorOutput);
    // Resolving the same node through a role+NAME query is the part that matters: it is the attribute being used
    // for naming, not merely present on the element.
    expect(screen.getByRole("separator", { name: strings.shell.splitter.editorOutput })).toBe(separator);

    // The whole point is telling the two apart, so identical names would be as useless as none. Both call sites
    // draw from these two constants (`App.tsx` and `OutputTiles.tsx`), so pinning them here pins the pair.
    expect(strings.shell.splitter.editorOutput).not.toBe(strings.shell.splitter.outputWebView);
    expect(strings.shell.splitter.editorOutput.length).toBeGreaterThan(0);
    expect(strings.shell.splitter.outputWebView.length).toBeGreaterThan(0);
  });
});
