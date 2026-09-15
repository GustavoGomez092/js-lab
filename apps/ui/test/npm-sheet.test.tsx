import { describe, expect, mock, test } from "bun:test";
import type { NpmListResult, NpmSearchResult } from "@jslab/rpc-schema";
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
  revision: 1,
};

function fakeApi(list: NpmListResult) {
  return {
    npmList: mock(async (_refresh: boolean) => list),
    npmSearch: mock(async (_query: string) => ({
      results: [{ name: "zod", version: "4.6.4", description: "schemas", weeklyDownloads: 1234 }] as NpmSearchResult[],
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

    // M-6 (closed here); fix round 2 (M-3) adds the drawer assertion: a leaked credential in a raw log must
    // never reach the drawer's own stream, the failure card or the Copy Log payload.
    const writeText = mock(async (_text: string) => {});
    const originalClipboard = navigator.clipboard;
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    // Fix round 2 (M-3): the log drawer reads the appendNpmLog stream (npm.logs), not error.log, so it needs its
    // own credential to prove the store masks that path too — the earlier "op10" test never called this.
    // Fix round 3: the store's carry is line-based, so the line ends in a newline to reach the complete-line
    // masking path (not only the terminal flush).
    act(() =>
      store
        .getState()
        .appendNpmLog(
          "op10",
          `https://user:secret@registry.example/ //registry.example/:_authToken=abc123${String.fromCharCode(10)}`,
        ),
    );
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
    // Both the failure card's disclosure and the log drawer now show this masked text, so more than one element
    // matches.
    expect(screen.getAllByText(/registry\.example/).length).toBeGreaterThan(0);
    const drawerText = document.querySelector(".npm-log pre")?.textContent ?? "";
    expect(drawerText.includes("secret")).toBe(false);
    expect(drawerText.includes("abc123")).toBe(false);
    expect(drawerText.includes("registry.example")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: strings.npm.copyLog }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const copied = writeText.mock.calls[0]?.[0] as string;
    expect(copied.includes("secret")).toBe(false);
    expect(copied.includes("abc123")).toBe(false);
    Object.defineProperty(navigator, "clipboard", { value: originalClipboard, configurable: true });

    // Fix round 2 (M-2): the stored target is masked, but Retry must still send the real spec.
    act(() =>
      store.getState().receiveNpmOperation({
        id: "op11",
        kind: "install",
        target: "git+https://ghp_FAKE@github.com/o/r.git",
        status: "failed",
        error: { kind: "unknown", log: "clone failed" },
        notice: null,
      }),
    );
    expect(screen.queryByText(/ghp_FAKE/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: strings.npm.retry }));
    expect(api.npmInstall).toHaveBeenCalledWith("git+https://ghp_FAKE@github.com/o/r.git");
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
    const { store, api } = setup();
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

    // Fix round 2 (M-6): a result row shows "Adding…" only for a pending *install* of that exact package, by
    // name, not any pending operation whose target happens to equal the name.
    const search = screen.getByRole("searchbox", { name: strings.npm.searchLabel });
    fireEvent.change(search, { target: { value: "zod" } });
    await waitFor(() => expect(api.npmSearch).toHaveBeenCalledWith("zod"), { timeout: 1000 });
    await screen.findByRole("option");
    act(() =>
      store.getState().receiveNpmOperation({
        id: "r1",
        kind: "remove",
        target: "zod",
        status: "queued",
        error: null,
        notice: null,
      }),
    );
    expect(screen.getByRole("button", { name: strings.npm.add("zod") })).toBeTruthy();
    act(() =>
      store.getState().receiveNpmOperation({
        id: "r2",
        kind: "install",
        target: "zod@4.6.4",
        status: "queued",
        error: null,
        notice: null,
      }),
    );
    expect(screen.queryByRole("button", { name: strings.npm.add("zod") })).toBeNull();
    expect(screen.getByText(strings.npm.adding)).toBeTruthy();
  });

  test("a search with no matches shows a message, and an @types-only install shows a hidden count (R26-5)", async () => {
    const onlyTypes: NpmListResult = {
      installed: [{ name: "@types/fixture-a", version: "1.0.0", latest: null }],
      outdatedCheckedAt: null,
      outdatedError: null,
      revision: 1,
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

  // Fix round 2 (M-4): row buttons disable only once Main's queued echo makes the round trip, so a double click
  // before that echo arrives must still queue only one operation.
  test("double-clicking an action queues it once, and Update all disables while one is queued", async () => {
    const { store, api } = setup();
    await screen.findByText("fixture-a");
    const remove = screen.getByRole("button", { name: strings.npm.remove("fixture-a") });
    fireEvent.click(remove);
    fireEvent.click(remove);
    expect(api.npmRemove.mock.calls).toEqual([["fixture-a"]]);

    const updateAll = screen.getByRole("button", { name: strings.npm.updateAll });
    fireEvent.click(updateAll);
    fireEvent.click(updateAll);
    expect(api.npmUpdateAll.mock.calls.length).toBe(1);

    act(() =>
      store.getState().receiveNpmOperation({
        id: "ua1",
        kind: "updateAll",
        target: "",
        status: "queued",
        error: null,
        notice: null,
      }),
    );
    expect((screen.getByRole("button", { name: strings.npm.updateAll }) as HTMLButtonElement).disabled).toBe(true);
  });

  // Fix round 2 (M-5): the resolver always called setResults with no check that its query was still current.
  test("an out-of-order search response doesn't replace newer results, and a post-install response leaves the list empty", async () => {
    const store = createAppStore();
    store.getState().hydrate({
      settings: defaultSettings(),
      session: defaultSession(() => createTab({ id: "t1" })),
      buffers: { t1: "" },
      safeMode: { active: false, reason: null },
      versions: { app: "0", bun: "1.4.0" },
    });
    type SearchResponse = { results: NpmSearchResult[]; error: null };
    const resolve: Record<string, (value: SearchResponse) => void> = {};
    const api = fakeApi(LIST);
    api.npmSearch.mockImplementation(
      (query: string) =>
        new Promise<SearchResponse>((res) => {
          resolve[query] = res;
        }),
    );
    render(<NpmSheet store={store} api={api} />);
    act(() => store.getState().openModal({ kind: "npm" }));
    await screen.findByText("fixture-a");
    const search = screen.getByRole("searchbox", { name: strings.npm.searchLabel });

    fireEvent.change(search, { target: { value: "zod" } });
    await waitFor(() => expect(resolve.zod).toBeTruthy(), { timeout: 1000 });
    fireEvent.change(search, { target: { value: "zodiac" } });
    await waitFor(() => expect(resolve.zodiac).toBeTruthy(), { timeout: 1000 });

    act(() =>
      resolve.zodiac?.({
        results: [{ name: "zodiac", version: "1.0.0", description: "", weeklyDownloads: null }],
        error: null,
      }),
    );
    await screen.findByText("zodiac");
    act(() =>
      resolve.zod?.({
        results: [{ name: "zod", version: "4.6.4", description: "", weeklyDownloads: null }],
        error: null,
      }),
    );
    expect(screen.queryByText("zod")).toBeNull();
    expect(screen.getAllByRole("option")).toHaveLength(1);

    fireEvent.change(search, { target: { value: "another" } });
    await waitFor(() => expect(resolve.another).toBeTruthy(), { timeout: 1000 });
    fireEvent.click(screen.getByRole("button", { name: strings.npm.add("zodiac") }));
    act(() =>
      resolve.another?.({
        results: [{ name: "another", version: "1.0.0", description: "", weeklyDownloads: null }],
        error: null,
      }),
    );
    expect(screen.queryByRole("option")).toBeNull();
  });

  // R-M3-OUTDATED-1: this reproduces the npm-panel E2E flake at unit level (analysis H6). The sheet's own
  // `npm.list(true)` response can resolve AFTER a `npm.changed` push has already landed in the store; the response
  // must never erase the push's error because it's actually the older result (a lower revision).
  test("the network hint survives a list reply that arrives after the change push", async () => {
    const store = createAppStore();
    store.getState().hydrate({
      settings: defaultSettings(),
      session: defaultSession(() => createTab({ id: "t1" })),
      buffers: { t1: "" },
      safeMode: { active: false, reason: null },
      versions: { app: "0", bun: "1.4.0" },
    });
    let resolveList!: (list: NpmListResult) => void;
    const api = fakeApi(LIST);
    api.npmList.mockImplementation(
      (_refresh: boolean) =>
        new Promise<NpmListResult>((resolve) => {
          resolveList = resolve;
        }),
    );
    render(<NpmSheet store={store} api={api} />);
    act(() => store.getState().openModal({ kind: "npm" }));
    await waitFor(() => expect(api.npmList).toHaveBeenCalledWith(true));

    // The `npm.changed` push (App.tsx's api.on("npm.changed", ...) listener) delivers the newer, network-failed
    // result first — before the sheet's own deferred response settles.
    act(() =>
      store.getState().receiveNpmList({
        installed: [],
        outdatedCheckedAt: 5,
        outdatedError: { kind: "network", log: "connection refused" },
        revision: 2,
      }),
    );

    // Now the sheet's own npmList(true) response resolves, carrying the stale, lower revision.
    await act(async () => {
      resolveList({ installed: [], outdatedCheckedAt: null, outdatedError: null, revision: 1 });
      await Bun.sleep(1);
    });

    expect(await screen.findByText(strings.npm.outdatedFailed(strings.npm.hints.network))).toBeTruthy();
  });
});
