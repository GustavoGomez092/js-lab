import { describe, expect, test } from "bun:test";
import type { BootstrapPayload } from "@jslab/rpc-schema";
import { createTab, defaultSession, defaultSettings } from "@jslab/shared";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { AboutDialog } from "../src/shell/AboutDialog";
import { createAppStore } from "../src/state/store";
import { createFakeApi } from "./fake-api";

/**
 * M6: About, credits and open-source notices.
 *
 * The English asserted here is written as literals ("Version 9.9.9", "MIT License", ...) rather than as
 * `strings.about.*` lookups. Comparing the dialog's output against the very catalogue entry the dialog read
 * would agree with itself no matter what that entry said -- including after a rename that left the dialog
 * rendering raw keys. The version numbers are deliberately not the real ones either, so a component that
 * hardcoded a version instead of reading the store would fail rather than coincidentally match.
 */
function setup(versions: BootstrapPayload["versions"] = { app: "9.9.9", bun: "1.4.0", electrobun: "2.0.1" }) {
  const store = createAppStore();
  store.getState().hydrate({
    settings: defaultSettings(),
    session: defaultSession(() => createTab({ id: "t1" })),
    buffers: { t1: "" },
    safeMode: { active: false, reason: null },
    versions,
  });
  const { api } = createFakeApi();
  render(<AboutDialog store={store} api={api} />);
  const open = () => act(() => store.getState().openModal({ kind: "about" }));
  return { store, api, open };
}

describe("AboutDialog (M6: About, credits, open-source notices)", () => {
  test("renders nothing until the About command opens it", () => {
    const { open } = setup();
    expect(screen.queryByRole("dialog")).toBeNull();
    open();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  test("names the app, both runtime versions and the MIT licence", () => {
    const { open } = setup();
    open();
    const facts = screen.getByTestId("about-facts").textContent ?? "";
    // Each version is read from the store, so a dialog wired to the wrong field (bun's number under "Version",
    // say) cannot satisfy all three at once -- the three fixture values are distinct for exactly that reason.
    expect(facts).toContain("Version 9.9.9");
    expect(facts).toContain("Bun 1.4.0");
    expect(facts).toContain("Electrobun 2.0.1");
    // The licence JSLab actually ships under (root LICENSE, and "license": "MIT" in the root package.json).
    const dialog = screen.getByRole("dialog").textContent ?? "";
    expect(dialog).toContain("MIT License");
    expect(dialog).toContain("Copyright (c) 2026 JSLab contributors");
    expect(screen.getByRole("heading", { name: "About JSLab" })).toBeTruthy();
  });

  test("an Electrobun version Main did not send shows no row at all, rather than 'undefined'", () => {
    // `electrobun` is optional on the wire, so this is the shape a build that omitted it would produce. The
    // negative assertion is the point: a naive render would print "Electrobun undefined".
    const { open } = setup({ app: "9.9.9", bun: "1.4.0" });
    open();
    const facts = screen.getByTestId("about-facts").textContent ?? "";
    expect(facts).toContain("Version 9.9.9");
    expect(facts).not.toContain("Electrobun");
    expect(facts).not.toContain("undefined");
  });

  test("Open-Source Notices asks Main for the notices file and nothing else", () => {
    const { api, open } = setup();
    open();
    fireEvent.click(screen.getByRole("button", { name: "Open-Source Notices…" }));
    // The exact action, as a literal: the UI never names a filesystem path (spec §18), and Main is the only
    // process that knows where THIRD-PARTY-NOTICES.md landed in the bundle.
    expect(api.appCommand.mock.calls).toEqual([["openThirdPartyNotices"]]);
  });

  test("Escape closes the dialog, and so does the Close button", () => {
    const viaEscape = setup();
    viaEscape.open();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(viaEscape.store.getState().modal).toBeNull();
    // Nothing is sent to Main by merely opening and dismissing the dialog.
    expect(viaEscape.api.appCommand).not.toHaveBeenCalled();

    const viaButton = setup();
    viaButton.open();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(viaButton.store.getState().modal).toBeNull();
  });

  test("focus moves in, Tab stays trapped, and closing returns focus to the opener", () => {
    const { store, open } = setup();
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    expect(document.activeElement).toBe(opener);

    open();
    const dialog = screen.getByRole("dialog");
    // Focus lands on the dismiss control, not on <body>: a Vim user's next keystrokes must not fall through.
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect((document.activeElement as HTMLElement).textContent).toBe("Close");

    // Tab cycles inside the dialog rather than reaching the editor behind the backdrop.
    fireEvent.keyDown(document, { key: "Tab" });
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(dialog.contains(document.activeElement)).toBe(true);

    act(() => store.getState().closeModal());
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});
