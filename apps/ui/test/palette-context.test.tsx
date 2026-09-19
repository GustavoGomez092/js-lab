import { describe, expect, test } from "bun:test";
import { createTab, defaultSession, defaultSettings } from "@jslab/shared";
import { render } from "@testing-library/react";
import { CommandRegistry } from "../src/commands/registry";
import { createViewCommands } from "../src/commands/view-commands";
import { type EditorHandle, setEditorHandle } from "../src/editor/editor-handle";
import { OutputPanel } from "../src/output/OutputPanel";
import { paletteContext } from "../src/palette/context";
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

/** What App.tsx asks when ⌘⇧P opens the palette, called here exactly as the shell calls it. */
const contextNow = (store: ReturnType<typeof setup>["store"]) =>
  paletteContext(document.activeElement, store.getState().focus);

describe("palette context", () => {
  // THE payoff. The palette derives its context from live DOM focus, so before a keyboard route to the output
  // existed that context was an accident of the user's mouse history. These two commands are what make it
  // something a keyboard user can choose; if this is unpinned, the change is decorative.
  test("the focus commands decide whether the palette opens in output or editor context", () => {
    const { store, api, registry } = setup();
    const view = render(<OutputPanel store={store} api={api} />);
    const editor = mountEditor();
    try {
      registry.execute("view.focusOutput");
      expect(contextNow(store)).toBe("output");

      registry.execute("view.focusEditor");
      expect(contextNow(store)).toBe("editor");

      // ...and back again, so a single sticky value can't pass this.
      registry.execute("view.focusOutput");
      expect(contextNow(store)).toBe("output");
    } finally {
      editor.remove();
      view.unmount();
    }
  });

  // Fix round 1 (m-5), preserved: live DOM focus wins over a stale store.focus, and store.focus is consulted only
  // when nothing meaningful has focus.
  test("live DOM focus wins over a stale store.focus, which is the fallback for an unfocused window", () => {
    const { store, api } = setup();
    const view = render(<OutputPanel store={store} api={api} />);
    const editor = mountEditor();
    try {
      store.getState().setFocus("output");
      editor.node.focus();
      expect(contextNow(store)).toBe("editor");

      (document.activeElement as HTMLElement | null)?.blur();
      // Compared by tag name rather than identity: a failed `toBe(document.body)` serializes the entire document.
      expect(document.activeElement?.tagName).toBe("BODY");
      expect(contextNow(store)).toBe("output");

      store.getState().setFocus("editor");
      expect(contextNow(store)).toBe("editor");
    } finally {
      editor.remove();
      view.unmount();
    }
  });
});
