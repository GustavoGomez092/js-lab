import { describe, expect, mock, test } from "bun:test";
import { createTab, defaultSession, defaultSettings } from "@jslab/shared";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EnvVarsSheet } from "../src/env/EnvVarsSheet";
import { createAppStore } from "../src/state/store";
import { strings } from "../src/strings";

function setup(
  variables: Record<string, string> = { TOKEN: "s3cr3t" },
  saveResult: { ok: true } | { ok: false; error: string } = { ok: true },
) {
  const store = createAppStore();
  store.getState().hydrate({
    settings: defaultSettings(),
    session: defaultSession(() => createTab({ id: "t1" })),
    buffers: { t1: "" },
    safeMode: { active: false, reason: null },
    versions: { app: "0", bun: "1.4.0" },
  });
  const api = {
    getEnv: mock(async () => variables),
    saveEnv: mock(async (_variables: Record<string, string>) => saveResult),
  };
  render(<EnvVarsSheet store={store} api={api} />);
  act(() => store.getState().openModal({ kind: "env" }));
  return { store, api };
}

describe("Environment Variables sheet (spec §12.1)", () => {
  test("values are masked until revealed, and Add then Save persists and closes", async () => {
    const { store, api } = setup();
    const value = (await screen.findByLabelText(strings.env.valueOf("TOKEN"))) as HTMLInputElement;
    expect(value.type).toBe("password");
    fireEvent.click(screen.getByRole("button", { name: strings.env.reveal("TOKEN") }));
    expect((screen.getByLabelText(strings.env.valueOf("TOKEN")) as HTMLInputElement).type).toBe("text");
    fireEvent.change(screen.getByLabelText(strings.env.newKey), { target: { value: "API_URL" } });
    fireEvent.change(screen.getByLabelText(strings.env.newValue), { target: { value: "https://x" } });
    fireEvent.click(screen.getByRole("button", { name: strings.env.add }));
    fireEvent.click(screen.getByRole("button", { name: strings.env.save }));
    await waitFor(() => expect(store.getState().modal).toBeNull());
    expect(api.saveEnv).toHaveBeenCalledWith({ TOKEN: "s3cr3t", API_URL: "https://x" });
    // R25-5: a successful save confirms its effect with a status message naming the count.
    expect(store.getState().statusMessage).toBe(strings.env.saved(2));
  });

  test("invalid and duplicate keys show errors and nothing is saved", async () => {
    const { store, api } = setup({ A: "1" });
    await screen.findByLabelText(strings.env.valueOf("A"));
    fireEvent.change(screen.getByLabelText(strings.env.newKey), { target: { value: "A" } });
    fireEvent.click(screen.getByRole("button", { name: strings.env.save }));
    expect(await screen.findByText(strings.env.errors.duplicateKey)).toBeTruthy();
    // R25-4: a failed Save focuses the first invalid key, for keyboard and VoiceOver users.
    expect(document.activeElement).toBe(screen.getByLabelText(strings.env.keyOf(2)));
    fireEvent.change(screen.getByLabelText(strings.env.keyOf(2)), { target: { value: "1BAD" } });
    fireEvent.click(screen.getByRole("button", { name: strings.env.save }));
    expect(await screen.findByText(strings.env.errors.invalidKey)).toBeTruthy();
    expect(api.saveEnv).not.toHaveBeenCalled();
    expect(store.getState().modal).toEqual({ kind: "env" });
  });

  test("Cancel discards changes, and a failed save stays open with the error", async () => {
    const failing = setup({ A: "1" }, { ok: false, error: "EACCES: permission denied" });
    await screen.findByLabelText(strings.env.valueOf("A"));
    fireEvent.click(screen.getByRole("button", { name: strings.env.save }));
    expect(await screen.findByText(strings.env.saveFailed("EACCES: permission denied"))).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: strings.env.cancel }));
    expect(failing.store.getState().modal).toBeNull();
  });

  test("Tab stays inside the sheet, and closing restores focus to the opener (R25-1)", async () => {
    const { store } = setup();
    await screen.findByLabelText(strings.env.valueOf("TOKEN"));
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    try {
      act(() => store.getState().closeModal());
      opener.focus();
      act(() => store.getState().openModal({ kind: "env" }));
      await screen.findByLabelText(strings.env.valueOf("TOKEN"));
      fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
      expect(store.getState().modal).toBeNull();
      expect(document.activeElement).toBe(opener);

      opener.focus();
      act(() => store.getState().openModal({ kind: "env" }));
      await screen.findByLabelText(strings.env.valueOf("TOKEN"));
      const save = screen.getByRole("button", { name: strings.env.save });
      save.focus();
      fireEvent.keyDown(document.activeElement as Element, { key: "Tab" });
      expect(document.activeElement).toBe(screen.getByLabelText(strings.env.keyOf(1)));
    } finally {
      opener.remove();
    }
  });

  test("a failed load disables Save, and cmd+enter leaves saveEnv uncalled (R25-2)", async () => {
    const store = createAppStore();
    store.getState().hydrate({
      settings: defaultSettings(),
      session: defaultSession(() => createTab({ id: "t1" })),
      buffers: { t1: "" },
      safeMode: { active: false, reason: null },
      versions: { app: "0", bun: "1.4.0" },
    });
    const api = {
      getEnv: mock(() => Promise.reject(new Error("EIO"))),
      saveEnv: mock(async () => ({ ok: true }) as const),
    };
    render(<EnvVarsSheet store={store} api={api} />);
    act(() => store.getState().openModal({ kind: "env" }));
    expect(await screen.findByText(strings.env.loadFailed)).toBeTruthy();
    expect((screen.getByRole("button", { name: strings.env.save }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter", metaKey: true });
    expect(api.saveEnv).not.toHaveBeenCalled();
  });

  test("pasting a .env block into New key adds every variable at once (R25-3)", async () => {
    const { store } = setup();
    await screen.findByLabelText(strings.env.valueOf("TOKEN"));
    fireEvent.paste(screen.getByLabelText(strings.env.newKey), {
      clipboardData: { getData: () => "X=1\nY=2" },
    });
    expect(await screen.findByLabelText(strings.env.valueOf("Y"))).toBeTruthy();
    expect(store.getState().modal).toEqual({ kind: "env" });
  });

  test("an empty table shows the empty state (R25-6)", async () => {
    setup({});
    expect(await screen.findByText(strings.env.empty)).toBeTruthy();
  });

  test("a rejected save shows the error and keeps the sheet open (R-M3-T25-SAVE-1)", async () => {
    const store = createAppStore();
    store.getState().hydrate({
      settings: defaultSettings(),
      session: defaultSession(() => createTab({ id: "t1" })),
      buffers: { t1: "" },
      safeMode: { active: false, reason: null },
      versions: { app: "0", bun: "1.4.0" },
    });
    const api = { getEnv: mock(async () => ({ A: "1" })), saveEnv: mock(() => Promise.reject(new Error("boom"))) };
    render(<EnvVarsSheet store={store} api={api} />);
    act(() => store.getState().openModal({ kind: "env" }));
    await screen.findByLabelText(strings.env.valueOf("A"));
    fireEvent.click(screen.getByRole("button", { name: strings.env.save }));
    expect(await screen.findByText(strings.env.saveFailed("boom"))).toBeTruthy();
    expect(store.getState().modal).toEqual({ kind: "env" });
  });
});
