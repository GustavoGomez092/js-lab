import { describe, expect, test } from "bun:test";
import { tabPatchSchema } from "@jslab/rpc-schema";
import { createTab, defaultSession, defaultSettings, type Runtime, type TabState } from "@jslab/shared";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { OutputTiles } from "../src/output/OutputTiles";
import { StatusBar } from "../src/shell/StatusBar";
import { computeTabPatch } from "../src/shell/tab-patch";
import { createAppStore } from "../src/state/store";
import { strings } from "../src/strings";
import { createFakeApi } from "./fake-api";

/** A fully-formed tab, so overriding `layout.tiles` never has to satisfy the schema's own defaults by hand twice. */
function tabWith(overrides: { runtime?: Runtime; tiles?: Partial<TabState["layout"]["tiles"]> }): TabState {
  return createTab({
    id: "t1",
    runtime: overrides.runtime ?? "browser",
    layout: {
      orientation: "horizontal",
      editorSize: 55,
      outputVisible: true,
      tiles: {
        arrangement: "stacked",
        order: ["console", "webview"],
        webviewVisible: false,
        consoleSize: 55,
        ...overrides.tiles,
      },
    },
  });
}

function hydrated(overrides: Parameters<typeof tabWith>[0] = {}) {
  const store = createAppStore();
  store.getState().hydrate({
    settings: defaultSettings(),
    session: defaultSession(() => tabWith(overrides)),
    buffers: { t1: "" },
    safeMode: { active: false, reason: null },
    versions: { app: "0", bun: "1.4.0" },
  });
  return store;
}

describe("OutputTiles", () => {
  test("a bun tab renders only the Console tile -- no nested split, no <electrobun-webview> (spec §7.1)", () => {
    const store = hydrated({ runtime: "bun" });
    const { api } = createFakeApi();
    render(<OutputTiles store={store} api={api} />);
    expect(screen.getByRole("region", { name: strings.output.region })).toBeTruthy();
    expect(screen.queryByRole("separator")).toBeNull();
    expect(document.querySelector("electrobun-webview")).toBeNull();
    expect(screen.queryByTestId("webview-tile")).toBeNull();
  });

  test("a browser-mode tab mounts the Web View tile collapsed to zero size when hidden by default", () => {
    const store = hydrated({ runtime: "browser" });
    const { api } = createFakeApi();
    render(<OutputTiles store={store} api={api} />);
    expect(screen.getByRole("separator")).toBeTruthy();
    const tile = screen.getByTestId("webview-tile");
    expect(tile.getAttribute("aria-hidden")).toBe("true");
    expect(tile.style.width).toBe("0px");
    expect(tile.style.height).toBe("0px");
    // Mounted, not merely styled away: the actual <electrobun-webview> node exists underneath it.
    expect(tile.querySelector("electrobun-webview")).toBeTruthy();
  });

  test("toggling Web View visible collapses/expands the tile without recreating its <electrobun-webview> (M0-S4)", () => {
    const store = hydrated({ runtime: "browser" });
    const { api } = createFakeApi();
    render(<OutputTiles store={store} api={api} />);
    const before = document.querySelector("electrobun-webview");
    expect(before).toBeTruthy();

    act(() => store.getState().toggleWebviewVisible());
    expect(document.querySelector("electrobun-webview")).toBe(before);
    const tile = screen.getByTestId("webview-tile");
    expect(tile.getAttribute("aria-hidden")).toBe("false");
    expect(tile.style.width).toBe("");

    act(() => store.getState().toggleWebviewVisible());
    expect(document.querySelector("electrobun-webview")).toBe(before);
    expect(screen.getByTestId("webview-tile").getAttribute("aria-hidden")).toBe("true");
  });

  test("arrangement maps to the nested split's orientation, and order controls which tile renders first", () => {
    const stacked = hydrated({ runtime: "browser", tiles: { arrangement: "stacked" } });
    const { api } = createFakeApi();
    const { container, rerender } = render(<OutputTiles store={stacked} api={api} />);
    expect(container.querySelector(".split-vertical")).toBeTruthy();

    const sideBySide = hydrated({ runtime: "browser", tiles: { arrangement: "side-by-side" } });
    rerender(<OutputTiles store={sideBySide} api={api} />);
    expect(container.querySelector(".split-horizontal")).toBeTruthy();

    // Default order (["console", "webview"]): the Console region is the first, sized pane.
    const panes = container.querySelectorAll(".split-pane");
    expect(panes[0]?.querySelector(`[aria-label="${strings.output.region}"]`)).toBeTruthy();

    // Reversed order: Web View renders first instead.
    const reversed = hydrated({ runtime: "browser", tiles: { order: ["webview", "console"] } });
    rerender(<OutputTiles store={reversed} api={api} />);
    const reversedPanes = container.querySelectorAll(".split-pane");
    expect(reversedPanes[0]?.querySelector('[data-testid="webview-tile"]')).toBeTruthy();
  });

  test("dragging the nested split updates consoleSize, converted for which side Console renders on", () => {
    const store = hydrated({ runtime: "browser", tiles: { webviewVisible: true, order: ["console", "webview"] } });
    const { api } = createFakeApi();
    const { rerender } = render(<OutputTiles store={store} api={api} />);
    fireEvent.pointerDown(screen.getByRole("separator"));
    fireEvent.pointerMove(window, { clientX: 999999, clientY: 999999 });
    fireEvent.pointerUp(window);
    // jsdom's layout rect is all zeros, so the ratio is +Infinity; setConsoleSize's own clamp (10-90) is what
    // turns that into a deterministic, in-range value.
    expect(store.getState().tab?.layout.tiles.consoleSize).toBe(90);

    // With Console second, the same onResize(size) call must convert to the other side before storing.
    const reversed = hydrated({
      runtime: "browser",
      tiles: { webviewVisible: true, order: ["webview", "console"], consoleSize: 55 },
    });
    rerender(<OutputTiles store={reversed} api={api} />);
    act(() => {
      fireEvent.keyDown(screen.getByRole("separator"), { key: "ArrowRight" });
    });
    // ArrowRight steps `first`'s size (webview's share) up by 2, so Console's own share goes down by 2.
    expect(reversed.getState().tab?.layout.tiles.consoleSize).toBe(53);
  });

  test("the status bar's Web View toggle is disabled with a reason for the Bun runtime (R-M4-T8-DISABLED-1)", () => {
    const store = hydrated({ runtime: "bun" });
    render(<StatusBar store={store} onToggleLayout={() => {}} runKeys="⌘R" />);
    const toggle = screen.getByRole("button", { name: strings.shell.webView.show });
    expect(toggle.hasAttribute("disabled")).toBe(true);
    expect(toggle.getAttribute("title")).toBe(strings.shell.webView.unavailable);
  });

  test("the status bar's Web View toggle flips webviewVisible for a runtime that supports it", () => {
    const store = hydrated({ runtime: "browser" });
    render(<StatusBar store={store} onToggleLayout={() => {}} runKeys="⌘R" />);
    const toggle = screen.getByRole("button", { name: strings.shell.webView.show });
    expect(toggle.hasAttribute("disabled")).toBe(false);
    fireEvent.click(toggle);
    expect(store.getState().tab?.layout.tiles.webviewVisible).toBe(true);
    expect(screen.getByRole("button", { name: strings.shell.webView.hide })).toBeTruthy();
  });

  test("a tiles change survives the trip from the UI's tab.patch through Main's tabPatchSchema (R-M4-T8-PATCH-1)", () => {
    const before = tabWith({ runtime: "browser" });
    const next: TabState = {
      ...before,
      layout: { ...before.layout, tiles: { ...before.layout.tiles, webviewVisible: true, consoleSize: 40 } },
    };
    const patch = computeTabPatch(before, next);
    expect(patch).not.toBeNull();
    // The real Main-side validator (packages/rpc-schema): if `tiles` were missing from its `layout` whitelist, it
    // would be stripped here silently -- this assertion is what would have caught that.
    const parsed = tabPatchSchema.parse({ tabId: before.id, patch });
    expect(parsed.patch.layout?.tiles).toEqual({
      arrangement: "stacked",
      order: ["console", "webview"],
      webviewVisible: true,
      consoleSize: 40,
    });
    expect(computeTabPatch(before, before)).toBeNull();
  });
});
