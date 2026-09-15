import { describe, expect, mock, test } from "bun:test";
import { createTab, defaultSession, defaultSettings, MAX_ENV_VALUE_CHARS, MAX_ENV_VARS } from "@jslab/shared";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { type EditorHandle, setEditorHandle } from "../src/editor/editor-handle";
import { EnvVarsSheet } from "../src/env/EnvVarsSheet";
import { createAppStore } from "../src/state/store";
import { strings } from "../src/strings";

function hydratedStore() {
  const store = createAppStore();
  store.getState().hydrate({
    settings: defaultSettings(),
    session: defaultSession(() => createTab({ id: "t1" })),
    buffers: { t1: "" },
    safeMode: { active: false, reason: null },
    versions: { app: "0", bun: "1.4.0" },
  });
  return store;
}

function setup(
  variables: Record<string, string> = { TOKEN: "s3cr3t" },
  saveResult: { ok: true } | { ok: false; error: string } = { ok: true },
) {
  const store = hydratedStore();
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
    // Fix round 1 (M-6): secret inputs opt out of spellcheck/autocomplete, and New value starts masked.
    expect(value.getAttribute("spellcheck")).toBe("false");
    expect(value.getAttribute("autocomplete")).toBe("off");
    const newValueInput = screen.getByLabelText(strings.env.newValue) as HTMLInputElement;
    expect(newValueInput.type).toBe("password");
    expect(newValueInput.getAttribute("spellcheck")).toBe("false");
    expect(newValueInput.getAttribute("autocomplete")).toBe("off");
    expect((screen.getByLabelText(strings.env.newKey) as HTMLInputElement).getAttribute("autocomplete")).toBe("off");

    fireEvent.change(screen.getByLabelText(strings.env.newKey), { target: { value: "API_URL" } });
    fireEvent.change(screen.getByLabelText(strings.env.newValue), { target: { value: "https://x" } });
    fireEvent.click(screen.getByRole("button", { name: strings.env.add }));
    fireEvent.click(screen.getByRole("button", { name: strings.env.save }));
    await waitFor(() => expect(store.getState().modal).toBeNull());
    expect(api.saveEnv).toHaveBeenCalledWith({ TOKEN: "s3cr3t", API_URL: "https://x" });
    // R25-5: a successful save confirms its effect with a status message naming the count.
    expect(store.getState().statusMessage).toBe(strings.env.saved(2));

    // N-2: a duplicate row (same key and value as an existing one) also counts as unsaved changes, since
    // `dirty` now compares the row list itself instead of the collapsed (deduplicating) variables object.
    act(() => store.getState().openModal({ kind: "env" }));
    await screen.findByLabelText(strings.env.valueOf("TOKEN"));
    fireEvent.change(screen.getByLabelText(strings.env.newKey), { target: { value: "TOKEN" } });
    fireEvent.change(screen.getByLabelText(strings.env.newValue), { target: { value: "s3cr3t" } });
    fireEvent.click(screen.getByRole("button", { name: strings.env.add }));
    expect(screen.getByText(strings.tabs.unsaved)).toBeTruthy();
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

      // Fix round 1 (N-3): Shift+Tab from the first focusable wraps to the last.
      fireEvent.keyDown(document.activeElement as Element, { key: "Tab", shiftKey: true });
      const focusable = [
        ...screen.getByRole("dialog").querySelectorAll<HTMLElement>("input:not([disabled]), button:not([disabled])"),
      ];
      expect(document.activeElement).toBe(focusable.at(-1) ?? null);

      // Fix round 1 (N-3): a hidden [tabindex="0"] candidate is skipped when tabbing.
      const hiddenCandidate = document.createElement("div");
      hiddenCandidate.tabIndex = 0;
      hiddenCandidate.hidden = true;
      screen.getByRole("dialog").insertBefore(hiddenCandidate, screen.getByRole("dialog").firstChild);
      const key1 = screen.getByLabelText(strings.env.keyOf(1));
      key1.focus();
      fireEvent.keyDown(document.activeElement as Element, { key: "Tab", shiftKey: true });
      expect(document.activeElement).not.toBe(hiddenCandidate);
      expect(document.activeElement).toBe(focusable.at(-1) ?? null);
    } finally {
      opener.remove();
    }

    // Fix round 1 (M-7): with no recorded opener, closing falls back to the editor.
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);
    const editorFocus = mock(() => {});
    setEditorHandle({ focus: editorFocus } as unknown as EditorHandle);
    try {
      act(() => store.getState().openModal({ kind: "env" }));
      await screen.findByLabelText(strings.env.valueOf("TOKEN"));
      fireEvent.keyDown(document.body, { key: "Escape" });
      expect(editorFocus).toHaveBeenCalled();
    } finally {
      setEditorHandle(null);
    }
  });

  test("a failed load disables Save, and cmd+enter leaves saveEnv uncalled (R25-2)", async () => {
    // Part A: getEnv rejects.
    const store = hydratedStore();
    const api = {
      getEnv: mock(() => Promise.reject(new Error("EIO"))),
      saveEnv: mock(async () => ({ ok: true }) as const),
    };
    render(<EnvVarsSheet store={store} api={api} />);
    act(() => store.getState().openModal({ kind: "env" }));
    expect(await screen.findByText(strings.env.loadFailed)).toBeTruthy();
    expect((screen.getByText(strings.env.loadFailed) as HTMLElement).closest('[role="alert"]')).not.toBeNull();
    expect((screen.getByRole("button", { name: strings.env.save }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter", metaKey: true });
    expect(api.saveEnv).not.toHaveBeenCalled();
    // Fix round 1 (M-2): a paste while loaded is false still shows its own info line, and the load-failure
    // alert text is untouched by it.
    fireEvent.paste(screen.getByLabelText(strings.env.newKey), { clipboardData: { getData: () => "X=1\nY=2" } });
    expect(screen.getByText(strings.env.loadFailed)).toBeTruthy();
    expect(screen.getByText(strings.env.loadFailed).getAttribute("role")).toBe("alert");
    const info = await screen.findByText(strings.env.pasted(2));
    expect(info.getAttribute("role")).toBe("status");
    cleanup();

    // Part B (M-7): getEnv never resolves; Save and cmd+enter both leave saveEnv uncalled.
    const store2 = hydratedStore();
    const api2 = {
      getEnv: mock(() => new Promise<Record<string, string>>(() => {})),
      saveEnv: mock(async () => ({ ok: true }) as const),
    };
    render(<EnvVarsSheet store={store2} api={api2} />);
    act(() => store2.getState().openModal({ kind: "env" }));
    await screen.findByLabelText(strings.env.newKey);
    expect((screen.getByRole("button", { name: strings.env.save }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: strings.env.save }));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter", metaKey: true });
    expect(api2.saveEnv).not.toHaveBeenCalled();
    cleanup();

    // Part B continued (M-7): a stale getEnv resolving after close and reopen doesn't replace the new
    // session's rows — two manually resolved promises, one per session.
    let resolveFirst: (variables: Record<string, string>) => void = () => {};
    let resolveSecond: (variables: Record<string, string>) => void = () => {};
    let call = 0;
    const store3 = hydratedStore();
    const api3 = {
      getEnv: mock(
        () =>
          new Promise<Record<string, string>>((resolve) => {
            call += 1;
            if (call === 1) resolveFirst = resolve;
            else resolveSecond = resolve;
          }),
      ),
      saveEnv: mock(async () => ({ ok: true }) as const),
    };
    render(<EnvVarsSheet store={store3} api={api3} />);
    act(() => store3.getState().openModal({ kind: "env" }));
    await screen.findByLabelText(strings.env.newKey);
    act(() => store3.getState().closeModal());
    act(() => store3.getState().openModal({ kind: "env" }));
    await screen.findByLabelText(strings.env.newKey);
    await act(async () => {
      resolveSecond({ FRESH: "1" });
      await Promise.resolve();
      await Promise.resolve();
    });
    await screen.findByLabelText(strings.env.valueOf("FRESH"));
    await act(async () => {
      resolveFirst({ STALE: "1" });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.queryByLabelText(strings.env.valueOf("STALE"))).toBeNull();
    expect(screen.getByLabelText(strings.env.valueOf("FRESH"))).toBeTruthy();
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

  test("reloads its rows when React re-invokes the mount effect on the same instance (FR-4)", async () => {
    // The sheet remounts EnvForm with a fresh `key` on every real open/close (severity note in the review), so
    // the `mounted` bug is otherwise latent. StrictMode's dev-only cleanup-then-reeffect on the SAME instance is
    // exactly the case the review names as making it live, and the only way to reproduce it through the public
    // component without reaching into EnvForm (which isn't exported).
    const store = hydratedStore();
    const api = { getEnv: mock(async () => ({ A: "1" })), saveEnv: mock(async () => ({ ok: true }) as const) };
    render(
      <StrictMode>
        <EnvVarsSheet store={store} api={api} />
      </StrictMode>,
    );
    act(() => store.getState().openModal({ kind: "env" }));
    expect(await screen.findByLabelText(strings.env.valueOf("A"))).toBeTruthy();
  });

  test("a rejected save shows the error and keeps the sheet open (R-M3-T25-SAVE-1)", async () => {
    const store = hydratedStore();
    const api = { getEnv: mock(async () => ({ A: "1" })), saveEnv: mock(() => Promise.reject(new Error("boom"))) };
    render(<EnvVarsSheet store={store} api={api} />);
    act(() => store.getState().openModal({ kind: "env" }));
    await screen.findByLabelText(strings.env.valueOf("A"));
    fireEvent.click(screen.getByRole("button", { name: strings.env.save }));
    expect(await screen.findByText(strings.env.saveFailed("boom"))).toBeTruthy();
    expect(store.getState().modal).toEqual({ kind: "env" });
  });

  test("a save is tied to its sheet session and runs once (fix round 1, M-1, N-5)", async () => {
    let resolveSave: (value: { ok: true }) => void = () => {};
    const store = hydratedStore();
    const api = {
      getEnv: mock(async () => ({ A: "1" })),
      saveEnv: mock(
        () =>
          new Promise<{ ok: true }>((resolve) => {
            resolveSave = resolve;
          }),
      ),
    };
    render(<EnvVarsSheet store={store} api={api} />);
    act(() => store.getState().openModal({ kind: "env" }));
    await screen.findByLabelText(strings.env.valueOf("A"));

    fireEvent.keyDown(document.body, { key: "Enter", metaKey: true });
    fireEvent.keyDown(document.body, { key: "Enter", metaKey: true });
    expect(api.saveEnv).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(store.getState().modal).toBeNull();
    act(() => store.getState().openModal({ kind: "env" }));
    await screen.findByLabelText(strings.env.valueOf("A"));
    fireEvent.change(screen.getByLabelText(strings.env.newKey), { target: { value: "NEW_DRAFT" } });

    await act(async () => {
      resolveSave({ ok: true });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(store.getState().modal).toEqual({ kind: "env" });
    expect((screen.getByLabelText(strings.env.newKey) as HTMLInputElement).value).toBe("NEW_DRAFT");
    expect(store.getState().statusMessage).not.toBe(strings.env.saved(1));
  });

  test("Escape and cmd+enter work after focus leaves the sheet's inputs (fix round 1, M-3)", async () => {
    const { store, api } = setup();
    await screen.findByLabelText(strings.env.valueOf("TOKEN"));
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(store.getState().modal).toBeNull();

    act(() => store.getState().openModal({ kind: "env" }));
    await screen.findByLabelText(strings.env.valueOf("TOKEN"));
    fireEvent.change(screen.getByLabelText(strings.env.newKey), { target: { value: "OK_KEY" } });
    fireEvent.change(screen.getByLabelText(strings.env.newValue), { target: { value: "v" } });
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);
    fireEvent.keyDown(document.body, { key: "Enter", metaKey: true });
    await waitFor(() => expect(api.saveEnv).toHaveBeenCalled());
  });

  test("limit errors show on the sheet and on the value field (fix round 1, M-5)", async () => {
    // Scenario 1: an over-long value marks the value input, not the key input, and focuses it.
    const { api } = setup({ A: "1" });
    await screen.findByLabelText(strings.env.valueOf("A"));
    const longValue = "x".repeat(MAX_ENV_VALUE_CHARS + 1);
    fireEvent.change(screen.getByLabelText(strings.env.valueOf("A")), { target: { value: longValue } });
    fireEvent.keyDown(document.body, { key: "Enter", metaKey: true });
    await waitFor(() =>
      expect(screen.getByLabelText(strings.env.valueOf("A")).getAttribute("aria-invalid")).toBe("true"),
    );
    expect(screen.getByLabelText(strings.env.keyOf(1)).getAttribute("aria-invalid")).toBe("false");
    expect(document.activeElement).toBe(screen.getByLabelText(strings.env.valueOf("A")));
    expect(api.saveEnv).not.toHaveBeenCalled();
    cleanup();

    // Scenario 2: too many keyed rows shows `tooMany` in the sheet-level alert.
    const NL = String.fromCharCode(10);
    const many = Array.from({ length: 501 }, (_, index) => `K${index}=v`).join(NL);
    const { api: api2 } = setup({});
    await screen.findByText(strings.env.empty);
    fireEvent.paste(screen.getByLabelText(strings.env.newKey), { clipboardData: { getData: () => many } });
    await screen.findByLabelText(strings.env.valueOf("K500"));
    fireEvent.keyDown(document.body, { key: "Enter", metaKey: true });
    const alert = await screen.findByText(strings.env.tooMany(MAX_ENV_VARS));
    expect(alert.getAttribute("role")).toBe("alert");
    expect(api2.saveEnv).not.toHaveBeenCalled();
  });
});
