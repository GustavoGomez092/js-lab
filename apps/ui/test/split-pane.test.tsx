import { describe, expect, spyOn, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { SplitPane } from "../src/shell/SplitPane";

describe("SplitPane", () => {
  test("removes drag listeners when unmounted mid-drag", () => {
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
  });
});
