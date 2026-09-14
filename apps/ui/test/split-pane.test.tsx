import { describe, expect, mock, spyOn, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { SplitPane } from "../src/shell/SplitPane";

describe("SplitPane", () => {
  test("removes drag listeners when unmounted mid-drag, or when the second pane is hidden mid-drag", () => {
    const removeEventListener = spyOn(window, "removeEventListener");
    try {
      const { unmount } = render(
        <SplitPane
          orientation="horizontal"
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
});
