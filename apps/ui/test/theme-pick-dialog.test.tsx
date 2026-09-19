import { afterEach, describe, expect, test } from "bun:test";
import { createTab, defaultSession, defaultSettings, mergeSettings } from "@jslab/shared";
import { registerUserThemes } from "@jslab/themes";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { createAppStore } from "../src/state/store";
import { ThemePickDialog } from "../src/themes/ThemePickDialog";
import { createFakeApi } from "./fake-api";

const choices = [
  { label: "Deep Dark", path: "extension/themes/deep.json" },
  { label: "Pale Light", path: "extension/themes/pale.json" },
];

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
  api.updateSettings.mockImplementation(async (patch: unknown) =>
    mergeSettings(defaultSettings(), patch as Parameters<typeof mergeSettings>[1]),
  );
  render(<ThemePickDialog store={store} api={api} />);
  const open = () => act(() => store.getState().openModal({ kind: "themePick", token: "t-1", choices }));
  return { store, api, open };
}

describe("ThemePickDialog (spec §9.3)", () => {
  afterEach(() => registerUserThemes([]));

  test("renders nothing until a .vsix actually offers a choice", () => {
    const { open } = setup();
    expect(screen.queryByRole("dialog")).toBeNull();
    open();
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual([
      "Deep Dark",
      "Pale Light",
      "Cancel",
    ]);
  });

  test("choosing a theme sends the archive entry name with the token, never a label or a path", async () => {
    const { store, api, open } = setup();
    api.importThemePick.mockImplementation(async () => ({
      ok: true,
      theme: { id: "pale-light", name: "Pale Light", type: "light" as const },
      notes: [],
    }));
    open();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Pale Light" }));
    });
    // The entry name the manifest declared -- spec §18: the UI never names a filesystem path.
    expect(api.importThemePick).toHaveBeenCalledWith("t-1", "extension/themes/pale.json");
    expect(store.getState().settings?.appearance.theme).toBe("pale-light");
    expect(store.getState().modal).toBeNull();
  });

  test("a second click while the first import is in flight sends nothing more", async () => {
    const { api, open } = setup();
    let release: (() => void) | null = null;
    api.importThemePick.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: false, error: "" });
        }),
    );
    open();
    const button = screen.getByRole("button", { name: "Deep Dark" });
    await act(async () => {
      fireEvent.click(button);
    });
    // The token is consumed by a successful pick, so a double click could only ever produce a second failure.
    await act(async () => {
      fireEvent.click(button);
    });
    expect(api.importThemePick).toHaveBeenCalledTimes(1);
    await act(async () => {
      release?.();
    });
  });

  test("Escape closes the picker without importing anything", () => {
    const { store, api, open } = setup();
    open();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect([store.getState().modal, api.importThemePick.mock.calls.length]).toEqual([null, 0]);
  });

  test("Cancel closes the picker without importing anything", () => {
    const { store, api, open } = setup();
    open();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect([store.getState().modal, api.importThemePick.mock.calls.length]).toEqual([null, 0]);
  });
});
