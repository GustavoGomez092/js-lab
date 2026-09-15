import { describe, expect, mock, test } from "bun:test";
import type { NpmListResult } from "@jslab/rpc-schema";
import { createTab, defaultSession, defaultSettings, mergeSettings } from "@jslab/shared";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NpmSheet } from "../src/npm/NpmSheet";
import { createAppStore } from "../src/state/store";
import { strings } from "../src/strings";

const LIST: NpmListResult = {
  installed: [
    { name: "@types/fixture-a", version: "1.0.0", latest: null },
    { name: "fixture-a", version: "1.0.0", latest: "1.1.0" },
  ],
  outdatedCheckedAt: 1,
  outdatedError: null,
};

function fakeApi(list: NpmListResult) {
  return {
    npmList: mock(async (_refresh: boolean) => list),
    npmSearch: mock(async (_query: string) => ({
      results: [{ name: "zod", version: "4.6.4", description: "schemas", weeklyDownloads: 1234 }],
      error: null,
    })),
    npmInstall: mock((_spec: string) => {}),
    npmRemove: mock((_name: string) => {}),
    npmUpdate: mock((_name: string) => {}),
    npmUpdateAll: mock(() => {}),
    updateSettings: mock(async (patch: Parameters<typeof mergeSettings>[1]) => mergeSettings(defaultSettings(), patch)),
  };
}

function setup(list: NpmListResult = LIST) {
  const store = createAppStore();
  store.getState().hydrate({
    settings: defaultSettings(),
    session: defaultSession(() => createTab({ id: "t1" })),
    buffers: { t1: "" },
    safeMode: { active: false, reason: null },
    versions: { app: "0", bun: "1.4.0" },
  });
  const api = fakeApi(list);
  render(<NpmSheet store={store} api={api} />);
  act(() => store.getState().openModal({ kind: "npm" }));
  return { store, api };
}

describe("NPM Packages sheet (spec §11.2)", () => {
  test("lists installed packages without @types by default, with Update, Remove and Update all", async () => {
    const { api } = setup();
    expect(await screen.findByText("fixture-a")).toBeTruthy();
    expect(api.npmList).toHaveBeenCalledWith(true);
    expect(screen.queryByText("@types/fixture-a")).toBeNull();
    // R26-1: fixture-a's 1.0.0 -> 1.1.0 is not a major crossing, so no badge.
    expect(screen.queryByText(strings.npm.major)).toBeNull();
    fireEvent.click(screen.getByLabelText(strings.npm.showTypes));
    expect(screen.getByText("@types/fixture-a")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: strings.npm.update("fixture-a") }));
    fireEvent.click(screen.getByRole("button", { name: strings.npm.remove("fixture-a") }));
    fireEvent.click(screen.getByRole("button", { name: strings.npm.updateAll }));
    expect([api.npmUpdate.mock.calls, api.npmRemove.mock.calls, api.npmUpdateAll.mock.calls.length]).toEqual([
      [["fixture-a"]],
      [["fixture-a"]],
      1,
    ]);
  });

  test("typing searches the registry, Add installs a result, and Enter installs a versioned spec", async () => {
    const { api } = setup();
    const search = screen.getByRole("searchbox", { name: strings.npm.searchLabel });
    fireEvent.change(search, { target: { value: "zod" } });
    await waitFor(() => expect(api.npmSearch).toHaveBeenCalledWith("zod"), { timeout: 1000 });
    expect(await screen.findByText(strings.npm.weekly(1234))).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: strings.npm.add("zod") }));
    fireEvent.change(search, { target: { value: "zod@4.6.4" } });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(api.npmInstall.mock.calls).toEqual([["zod"], ["zod@4.6.4"]]);
  });

  test("a failed operation shows its hint, its raw log and Retry; masked credentials never reach the drawer or Copy Log", async () => {
    const { store, api } = setup();
    await screen.findByText("fixture-a");
    act(() =>
      store.getState().receiveNpmOperation({
        id: "op9",
        kind: "install",
        target: "missing-pkg",
        status: "failed",
        error: { kind: "notFound", log: "error: package not found (404)" },
        notice: null,
      }),
    );
    expect(screen.getByText(strings.npm.hints.notFound)).toBeTruthy();
    expect(screen.getByText("error: package not found (404)")).toBeTruthy();
    fireEvent.click(screen.getByLabelText(strings.npm.allowScripts));
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ npm: { allowInstallScripts: true } }));

    // R26-4: Retry re-dispatches the same operation.
    fireEvent.click(screen.getByRole("button", { name: strings.npm.retry }));
    expect(api.npmInstall).toHaveBeenCalledWith("missing-pkg");

    // M-6 (closed here): a leaked credential in a raw log must never reach the drawer or the Copy Log payload.
    const writeText = mock(async (_text: string) => {});
    const originalClipboard = navigator.clipboard;
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    act(() =>
      store.getState().receiveNpmOperation({
        id: "op10",
        kind: "install",
        target: "leaky-pkg",
        status: "failed",
        error: { kind: "notFound", log: "https://user:secret@registry.example/ //registry.example/:_authToken=abc123" },
        notice: null,
      }),
    );
    expect(screen.queryByText(/secret/)).toBeNull();
    expect(screen.queryByText(/abc123/)).toBeNull();
    expect(screen.getByText(/registry\.example/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: strings.npm.copyLog }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const copied = writeText.mock.calls[0]?.[0] as string;
    expect(copied.includes("secret")).toBe(false);
    expect(copied.includes("abc123")).toBe(false);
    Object.defineProperty(navigator, "clipboard", { value: originalClipboard, configurable: true });
  });

  test("↑/↓ selects a result for Return to install, and Escape clears a non-empty search before closing the sheet (R26-2)", async () => {
    const { store, api } = setup();
    await screen.findByText("fixture-a");
    const search = screen.getByRole("searchbox", { name: strings.npm.searchLabel }) as HTMLInputElement;
    fireEvent.change(search, { target: { value: "zod" } });
    await waitFor(() => expect(api.npmSearch).toHaveBeenCalledWith("zod"), { timeout: 1000 });
    await screen.findByText(strings.npm.weekly(1234));
    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(api.npmInstall).toHaveBeenCalledWith("zod");

    fireEvent.change(search, { target: { value: "zo" } });
    act(() => search.focus());
    fireEvent.keyDown(search, { key: "Escape" });
    expect(search.value).toBe("");
    expect(store.getState().modal).toEqual({ kind: "npm" });
  });

  test("a running operation shows in its row, disables that row's buttons, and the status line counts anything queued (R26-3)", async () => {
    const { store } = setup();
    await screen.findByText("fixture-a");
    act(() =>
      store.getState().receiveNpmOperation({
        id: "u1",
        kind: "update",
        target: "fixture-a",
        status: "running",
        error: null,
        notice: null,
      }),
    );
    expect((screen.getByRole("button", { name: strings.npm.update("fixture-a") }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByRole("button", { name: strings.npm.remove("fixture-a") }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.getByText(strings.npm.rowStatus("update", "running"))).toBeTruthy();
    act(() =>
      store.getState().receiveNpmOperation({
        id: "u2",
        kind: "install",
        target: "other-pkg",
        status: "queued",
        error: null,
        notice: null,
      }),
    );
    expect(screen.getByText(strings.npm.running("update", "fixture-a", 1))).toBeTruthy();
  });

  test("a search with no matches shows a message, and an @types-only install shows a hidden count (R26-5)", async () => {
    const onlyTypes: NpmListResult = {
      installed: [{ name: "@types/fixture-a", version: "1.0.0", latest: null }],
      outdatedCheckedAt: null,
      outdatedError: null,
    };
    const { api } = setup(onlyTypes);
    await waitFor(() => expect(api.npmList).toHaveBeenCalledWith(true));
    expect(await screen.findByText(strings.npm.typesHidden(1))).toBeTruthy();
    const search = screen.getByRole("searchbox", { name: strings.npm.searchLabel });
    fireEvent.change(search, { target: { value: "nothingmatches" } });
    api.npmSearch.mockImplementation(async (_query: string) => ({ results: [], error: null }));
    await waitFor(() => expect(api.npmSearch).toHaveBeenCalledWith("nothingmatches"), { timeout: 1000 });
    expect(await screen.findByText(strings.npm.noResults("nothingmatches"))).toBeTruthy();
  });
});
