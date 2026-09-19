import { describe, expect, test } from "bun:test";
import { createTab, defaultSession, defaultSettings } from "@jslab/shared";
import { render } from "@testing-library/react";
import { CommandRegistry } from "../src/commands/registry";
import { createViewCommands } from "../src/commands/view-commands";
import { type EditorHandle, setEditorHandle } from "../src/editor/editor-handle";
import { OutputPanel } from "../src/output/OutputPanel";
import { createAppStore } from "../src/state/store";
import { createFakeApi } from "./fake-api";

function setup() {
  const store = createAppStore();
  store.getState().hydrate({
    settings: defaultSettings(),
    session: defaultSession(() => createTab({ id: "t1" })),
    buffers: { t1: "" },
    safeMode: { active: false, reason: null },
    versions: { app: "0", bun: "1.4.0" },
  });
  const { api } = createFakeApi();
  const registry = new CommandRegistry();
  registry.register(...createViewCommands(store, api));
  return { store, api, registry };
}

/** A stand-in for the mounted Monaco editor: a real focusable node plus the handle commands focus through. */
function mountEditor() {
  const node = document.createElement("div");
  node.className = "editor";
  node.tabIndex = 0;
  document.body.appendChild(node);
  setEditorHandle({ focus: () => node.focus() } as unknown as EditorHandle);
  return {
    node,
    remove: () => {
      setEditorHandle(null);
      node.remove();
    },
  };
}

/**
 * A short, stable name for whatever currently has focus.
 *
 * These assertions are about where focus actually IS, not about whether some function was called -- but asserting
 * element identity directly (`toBe(scroller)`) makes a FAILURE unreadable: bun serializes the whole happy-dom node
 * as the expected value, tens of thousands of lines of it, and the "(fail) <test name>" line ends up spliced into
 * the middle of that dump. A failing run then looks green to anything that greps for the marker. Comparing the
 * element's class name keeps the same meaning and prints one line when it breaks.
 */
const focused = () => {
  const active = document.activeElement as HTMLElement | null;
  if (!active || active === document.body) return "body";
  return active.className || active.tagName.toLowerCase();
};

// UI item 2: from Monaco, Tab inserts a tab character, so before these commands there was no keyboard route to
// the output at all.
describe("focus commands", () => {
  test("view.focusOutput moves focus to the output scroller", () => {
    const { store, api, registry } = setup();
    const view = render(<OutputPanel store={store} api={api} />);
    try {
      expect(document.querySelector(".output-scroller")).not.toBeNull();
      expect(focused()).not.toBe("output-scroller");

      expect(registry.execute("view.focusOutput")).toBe("executed");

      expect(focused()).toBe("output-scroller");
    } finally {
      view.unmount();
    }
  });

  test("view.focusEditor moves focus back to the editor", () => {
    const { store, api, registry } = setup();
    const view = render(<OutputPanel store={store} api={api} />);
    const editor = mountEditor();
    try {
      registry.execute("view.focusOutput");
      expect(focused()).toBe("output-scroller");

      expect(registry.execute("view.focusEditor")).toBe("executed");

      expect(focused()).toBe("editor");
      expect(document.activeElement).toBe(editor.node);
    } finally {
      editor.remove();
      view.unmount();
    }
  });

  // The output panel is unmounted whenever the Output panel is hidden (and the scroller itself is replaced by the
  // Web View's dock when that tab is showing one), so the command must report itself unavailable rather than
  // silently doing nothing when the palette offers it.
  test("view.focusOutput is offered only while the output list is on screen", () => {
    const { store, api, registry } = setup();
    expect(registry.isEnabled("view.focusOutput")).toBe(false);
    const view = render(<OutputPanel store={store} api={api} />);
    expect(registry.isEnabled("view.focusOutput")).toBe(true);
    view.unmount();
    expect(registry.isEnabled("view.focusOutput")).toBe(false);
  });

  // The Web View docks into this panel in the log list's place, so the scroller isn't rendered at all. Dropping
  // `showingWebView` from the registering effect -- exactly what biome's "extra dependency" autofix proposes --
  // leaves a handle pointing at a detached node, and the palette goes on offering a command that focuses nothing.
  test("view.focusOutput is unavailable while the Web View is docked in the log list's place", () => {
    const { store, api, registry } = setup();
    const dock = <div data-testid="dock" />;
    const view = render(<OutputPanel store={store} api={api} webViewSlot={dock} />);
    try {
      expect(document.querySelector(".output-scroller")).toBeNull();
      expect(registry.isEnabled("view.focusOutput")).toBe(false);

      view.rerender(<OutputPanel store={store} api={api} />);
      expect(registry.isEnabled("view.focusOutput")).toBe(true);

      view.rerender(<OutputPanel store={store} api={api} webViewSlot={dock} />);
      expect(registry.isEnabled("view.focusOutput")).toBe(false);
    } finally {
      view.unmount();
    }
  });

  test("view.focusEditor is offered only while an editor is mounted", () => {
    const { registry } = setup();
    expect(registry.isEnabled("view.focusEditor")).toBe(false);
    const editor = mountEditor();
    try {
      expect(registry.isEnabled("view.focusEditor")).toBe(true);
    } finally {
      editor.remove();
    }
    expect(registry.isEnabled("view.focusEditor")).toBe(false);
  });
});
