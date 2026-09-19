import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { Toolbar } from "../src/shell/Toolbar";

/**
 * Double-click-to-zoom on the toolbar row (the hiddenInset title bar).
 *
 * The row is the window's drag handle, and its controls opt out of dragging with `app-region: no-drag`. These
 * tests pin the double-click to that same boundary. They are structural on purpose: happy-dom has no layout
 * engine and never loads styles.css, so the CSS opt-out itself is unobservable here -- `Toolbar` therefore
 * matches the controls by selector, and that selector is what is under test.
 *
 * Queries are scoped to this render's own container rather than the document, so one test can never pick up the
 * toolbar another test rendered.
 */
function renderToolbar(children?: ReactNode, runKeys: string | null = null) {
  const onZoom = mock(() => {});
  const noop = mock(() => {});
  const { container } = render(
    <Toolbar
      autoRun={false}
      busy={false}
      runKeys={runKeys}
      stopKeys={null}
      onToggleAutoRun={noop}
      onRun={noop}
      onStop={noop}
      onZoom={onZoom}
    >
      {children}
    </Toolbar>,
  );
  const el = (selector: string) => {
    const found = container.querySelector(selector);
    if (!found) throw new Error(`No element matched ${selector}`);
    return found;
  };
  return { onZoom, el };
}

describe("toolbar double-click zoom", () => {
  test("a double-click on the empty strip zooms the window", () => {
    const { onZoom, el } = renderToolbar();
    fireEvent.doubleClick(el("header.toolbar"));
    expect(onZoom).toHaveBeenCalledTimes(1);
  });

  test("a double-click on the traffic-light inset zooms: it is title bar, not a control", () => {
    const { onZoom, el } = renderToolbar();
    fireEvent.doubleClick(el(".toolbar-traffic"));
    expect(onZoom).toHaveBeenCalledTimes(1);
  });

  test("a double-click on the single-tab title zooms, like the title of a native title bar", () => {
    const { onZoom, el } = renderToolbar(<span className="toolbar-title">script.ts</span>);
    fireEvent.doubleClick(el(".toolbar-title"));
    expect(onZoom).toHaveBeenCalledTimes(1);
  });

  // The regression these guard: Run, Auto Run and the tab strip all sit inside the drag region, so a handler on
  // the row alone would fire on them too -- double-clicking Run or a tab title would zoom the window.
  test("a double-click on Run never zooms, not even on the keycap inside it", () => {
    const { onZoom, el } = renderToolbar(undefined, "⌘↵");
    // The keycap is a child of the button, so this only passes if the handler walks up to the control.
    fireEvent.doubleClick(el(".tb-btn.run .kbd"));
    expect(onZoom).not.toHaveBeenCalled();
    fireEvent.doubleClick(el(".tb-btn.run"));
    expect(onZoom).not.toHaveBeenCalled();
  });

  test("a double-click on the Auto Run button never zooms", () => {
    const { onZoom, el } = renderToolbar();
    fireEvent.doubleClick(el(".tb-btn[aria-pressed]"));
    expect(onZoom).not.toHaveBeenCalled();
  });

  test("a double-click on a tab title never zooms", () => {
    const { onZoom, el } = renderToolbar(
      <div className="tab-bar electrobun-webkit-app-region-no-drag" role="tablist">
        <div role="tab" className="tab" tabIndex={0}>
          <span className="tab-title">script.ts</span>
        </div>
      </div>,
    );
    // The event target is the inner span, so this only passes if the handler walks up to the tab.
    fireEvent.doubleClick(el(".tab-title"));
    expect(onZoom).not.toHaveBeenCalled();
  });
});
