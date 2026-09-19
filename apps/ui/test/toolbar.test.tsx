import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { Toolbar } from "../src/shell/Toolbar";
import { strings } from "../src/strings";

/**
 * Double-click-to-zoom on the toolbar row (the hiddenInset title bar).
 *
 * The row is the window's drag handle, and its controls opt out with `app-region: no-drag`. These tests pin the
 * double-click to that same boundary. They are structural on purpose: happy-dom has no layout engine and never
 * loads styles.css, so the CSS opt-out itself is unobservable here -- `Toolbar` therefore matches the controls by
 * selector, and that selector is what is under test.
 */
function renderToolbar(children?: ReactNode) {
  const onZoom = mock(() => {});
  const noop = mock(() => {});
  render(
    <Toolbar
      autoRun={false}
      busy={false}
      runKeys={null}
      stopKeys={null}
      onToggleAutoRun={noop}
      onRun={noop}
      onStop={noop}
      onZoom={onZoom}
    >
      {children}
    </Toolbar>,
  );
  return { onZoom };
}

describe("toolbar double-click zoom", () => {
  test("a double-click on the empty strip zooms the window", () => {
    const { onZoom } = renderToolbar();
    const header = document.querySelector("header.toolbar");
    expect(header).not.toBeNull();
    fireEvent.doubleClick(header as Element);
    expect(onZoom).toHaveBeenCalledTimes(1);
  });

  test("a double-click on the traffic-light inset zooms: it is title bar, not a control", () => {
    const { onZoom } = renderToolbar();
    fireEvent.doubleClick(document.querySelector(".toolbar-traffic") as Element);
    expect(onZoom).toHaveBeenCalledTimes(1);
  });

  test("a double-click on the single-tab title zooms, like the title of a native title bar", () => {
    const { onZoom } = renderToolbar(<span className="toolbar-title">script.ts</span>);
    fireEvent.doubleClick(screen.getByText("script.ts"));
    expect(onZoom).toHaveBeenCalledTimes(1);
  });

  // The regression this guards: Run, Auto Run and the tab strip all sit inside the drag region, so a handler on the
  // row alone would fire on them too -- double-clicking a tab title would zoom the window.
  test("a double-click on Run never zooms", () => {
    const { onZoom } = renderToolbar();
    fireEvent.doubleClick(screen.getByText(strings.shell.run, { exact: false }));
    expect(onZoom).not.toHaveBeenCalled();
  });

  test("a double-click on the Auto Run button never zooms", () => {
    const { onZoom } = renderToolbar();
    fireEvent.doubleClick(screen.getByText(strings.shell.autoRun, { exact: false }));
    expect(onZoom).not.toHaveBeenCalled();
  });

  test("a double-click on a tab, or on the keycap inside a button, never zooms", () => {
    const { onZoom } = renderToolbar(
      <div className="tab-bar electrobun-webkit-app-region-no-drag" role="tablist">
        <div role="tab" className="tab">
          <span className="tab-title">script.ts</span>
        </div>
      </div>,
    );
    // The event target is the inner span, so this only passes if the handler walks up to the control.
    fireEvent.doubleClick(screen.getByText("script.ts"));
    expect(onZoom).not.toHaveBeenCalled();
  });
});
