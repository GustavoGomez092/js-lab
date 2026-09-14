import { describe, expect, mock, test } from "bun:test";
import type { SettingsViewMessages } from "@jslab/rpc-schema";
import { defaultSettings, mergeSettings, type Settings } from "@jslab/shared";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SettingsApp } from "../src/settings/SettingsApp";
import { createSettingsAgent } from "../src/settings/settings-agent";
import type { SettingsApi } from "../src/settings/settings-rpc";

function fakeSettingsApi(fonts: Awaited<ReturnType<SettingsApi["listFonts"]>> = { fonts: null, refreshing: true }) {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  let current: Settings = defaultSettings();
  const api = {
    get: mock(async () => ({ settings: current, e2e: false })),
    update: mock(async (patch: Parameters<typeof mergeSettings>[1]) => {
      current = mergeSettings(current, patch);
      return current;
    }),
    listFonts: mock(async () => fonts),
    appCommand: mock((_action: string) => {}),
    e2eRespond: mock(() => {}),
    on(name: string, listener: (payload: never) => void) {
      const set = listeners.get(name) ?? new Set();
      listeners.set(name, set);
      set.add(listener as (payload: unknown) => void);
      return () => set.delete(listener as (payload: unknown) => void);
    },
  } satisfies SettingsApi;
  const emit = <K extends keyof SettingsViewMessages>(name: K, payload: SettingsViewMessages[K]) =>
    act(async () => {
      for (const listener of listeners.get(name) ?? []) listener(payload);
      await Bun.sleep(1);
    });
  return { api, emit };
}

describe("SettingsApp", () => {
  test("shows help text, switches tabs, applies toggles through Main and searches across tabs", async () => {
    const { api } = fakeSettingsApi();
    render(<SettingsApp api={api} initial={defaultSettings()} />);
    expect(screen.getByText("Run code automatically as you type.")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Editor" }));
    const wrap = screen.getByLabelText("Line Wrap") as HTMLInputElement;
    expect(wrap.checked).toBe(true);
    fireEvent.click(wrap);
    await waitFor(() => expect((screen.getByLabelText("Line Wrap") as HTMLInputElement).checked).toBe(false));
    expect(api.update).toHaveBeenCalledWith({ editor: { lineWrap: false } });
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "print width" } });
    expect(screen.getByLabelText("Print Width")).toBeTruthy();
    expect(screen.queryByLabelText("Line Wrap")).toBeNull();
  });

  test("numbers commit clamped on blur, and the theme and font pickers list their groups", async () => {
    const { api } = fakeSettingsApi({
      fonts: { monospace: ["Seeded Mono"], other: ["Seeded Sans"] },
      refreshing: false,
    });
    render(<SettingsApp api={api} initial={defaultSettings()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Appearance" }));
    const size = screen.getByLabelText("Font Size") as HTMLInputElement;
    fireEvent.change(size, { target: { value: "999" } });
    fireEvent.blur(size);
    await waitFor(() => expect(api.update).toHaveBeenCalledWith({ appearance: { fontSize: 72 } }));
    fireEvent.change(screen.getByLabelText("Font Size"), { target: { value: "big" } });
    fireEvent.blur(screen.getByLabelText("Font Size"));
    expect((screen.getByLabelText("Font Size") as HTMLInputElement).value).toBe("72");
    const theme = screen.getByLabelText("Theme") as HTMLSelectElement;
    expect([...theme.querySelectorAll("optgroup")].map((group) => group.label)).toEqual(["Dark", "Light"]);
    expect(theme.value).toBe("graphite");
    await waitFor(() => {
      const font = screen.getByLabelText("Font") as HTMLSelectElement;
      expect([...font.querySelectorAll("optgroup")].map((group) => group.label)).toEqual([
        "Bundled",
        "Installed monospace",
        "Installed",
      ]);
      expect([...font.options].map((option) => option.value)).toContain("Seeded Mono");
    });
  });

  test("Advanced actions: reset needs a second click; restart and data folder go to Main; broadcasts update the view", async () => {
    const { api, emit } = fakeSettingsApi();
    render(<SettingsApp api={api} initial={defaultSettings()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Advanced" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset All Settings…" }));
    expect(api.appCommand).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm Reset" }));
    fireEvent.click(screen.getByRole("button", { name: "Restart in Safe Mode" }));
    fireEvent.click(screen.getByRole("button", { name: "Open Data Folder" }));
    expect(api.appCommand.mock.calls).toEqual([["resetSettings"], ["restartSafeMode"], ["openDataFolder"]]);
    await emit("settings.changed", { settings: mergeSettings(defaultSettings(), { run: { showUndefined: true } }) });
    expect((screen.getByLabelText("Show Undefined") as HTMLInputElement).checked).toBe(true);
  });

  test("the Settings window E2E agent reports state, runs settings commands and types into fields", async () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    const execute = mock((id: string) => id === "settings.set");
    const agent = createSettingsAgent({
      state: () => ({ ready: true, tab: "general", query: "", fieldCount: 7, fontOptions: [], settings: null }),
      execute,
      target: () => input,
    });
    expect(await agent("state", {})).toMatchObject({ ready: true, fieldCount: 7 });
    expect(await agent("command", { id: "settings.set", args: { key: "view.statusBar", value: false } })).toEqual({
      executed: "settings.set",
    });
    await expect(agent("command", { id: "nope" })).rejects.toThrow("Unknown settings command: nope");
    await agent("type", { text: "print", replace: true });
    expect(input.value).toBe("print");
    await expect(agent("output", {})).rejects.toThrow("The Settings window has no output");
    input.remove();
  });
});
