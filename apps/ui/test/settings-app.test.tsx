import { describe, expect, mock, test } from "bun:test";
import type { CommandCatalogEntry, SettingsViewMessages } from "@jslab/rpc-schema";
import { defaultSettings, type KeybindingRule, mergeSettings, type Settings } from "@jslab/shared";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SettingsApp } from "../src/settings/SettingsApp";
import { createSettingsAgent } from "../src/settings/settings-agent";
import type { SettingsApi } from "../src/settings/settings-rpc";
import { strings } from "../src/strings";

const NL = String.fromCharCode(10);
const DEFAULT_REGISTRY_NPMRC = `registry=https://registry.npmjs.org/${NL}`;

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
    getNpmrc: mock(async () => DEFAULT_REGISTRY_NPMRC),
    saveNpmrc: mock(async (_content: string) => ({ ok: true as const })),
    resetNpmrc: mock(async () => DEFAULT_REGISTRY_NPMRC),
    commandCatalog: mock(async () => ({ commands: [] as CommandCatalogEntry[] })),
    getKeybindings: mock(async () => ({
      rules: [] as KeybindingRule[],
      defaults: [] as KeybindingRule[],
      path: "/data/keybindings.json",
    })),
    saveKeybindings: mock(async (_rules: KeybindingRule[]) => ({ ok: true as const })),
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

  test("a font scan that isn't refreshing is not polled again, and the picker says installed fonts couldn't load", async () => {
    const realSetTimeout = globalThis.setTimeout;
    const delays: (number | undefined)[] = [];
    globalThis.setTimeout = ((handler: TimerHandler, delay?: number, ...rest: unknown[]) => {
      delays.push(delay);
      return realSetTimeout(handler, delay, ...rest);
    }) as typeof setTimeout;
    try {
      const { api } = fakeSettingsApi({ fonts: null, refreshing: false });
      render(<SettingsApp api={api} initial={defaultSettings()} />);
      fireEvent.click(screen.getByRole("tab", { name: "Appearance" }));
      await waitFor(() => expect(screen.getByText("Couldn't load installed fonts")).toBeTruthy());
      expect(screen.queryByText("Loading installed fonts…")).toBeNull();
      expect(api.listFonts).toHaveBeenCalledTimes(1);
      // The font poll's 2 s re-check was never scheduled (review I-1).
      expect(delays).not.toContain(2000);
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });

  test("a failed save resyncs from Main, so a number field shows Main's value instead of the typed draft", async () => {
    const { api } = fakeSettingsApi();
    api.update.mockImplementationOnce(async () => {
      throw new Error("settings.json could not be written");
    });
    const mainValue = mergeSettings(defaultSettings(), { appearance: { fontSize: 22 } });
    api.get.mockImplementationOnce(async () => ({ settings: mainValue, e2e: false }));
    render(<SettingsApp api={api} initial={defaultSettings()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Appearance" }));
    fireEvent.change(screen.getByLabelText("Font Size"), { target: { value: "30" } });
    fireEvent.blur(screen.getByLabelText("Font Size"));
    await waitFor(() => expect((screen.getByLabelText("Font Size") as HTMLInputElement).value).toBe("22"));
    expect(api.update).toHaveBeenCalledWith({ appearance: { fontSize: 30 } });
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  // FB-m4: with Follow System on, the Settings window follows a macOS appearance change like the main window does.
  test("with Follow System on, the Settings window follows macOS appearance changes until unmounted (FB-m4)", () => {
    const listeners = new Set<() => void>();
    const media = {
      matches: true,
      addEventListener: (_type: "change", listener: () => void) => listeners.add(listener),
      removeEventListener: (_type: "change", listener: () => void) => listeners.delete(listener),
    };
    const realMatchMedia = window.matchMedia;
    window.matchMedia = (() => media) as unknown as typeof window.matchMedia;
    try {
      const { api } = fakeSettingsApi();
      const initial = mergeSettings(defaultSettings(), {
        appearance: { followSystem: true, lightTheme: "github-light", darkTheme: "dracula" },
      });
      const { unmount } = render(<SettingsApp api={api} initial={initial} />);
      expect(document.documentElement.dataset.theme).toBe("dracula");
      act(() => {
        media.matches = false;
        for (const listener of [...listeners]) listener();
      });
      expect(document.documentElement.dataset.theme).toBe("github-light");
      unmount();
      expect(listeners.size).toBe(0);
    } finally {
      window.matchMedia = realMatchMedia;
    }
  });

  test("the Settings window E2E agent reports state, runs settings commands and types into fields", async () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    const execute = mock((id: string) => id === "settings.set");
    const agent = createSettingsAgent({
      state: () => ({
        ready: true,
        tab: "general",
        query: "",
        fieldCount: 7,
        fontOptions: [],
        settings: null,
        npmrc: null,
      }),
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

  test("the NPM tab shows the .npmrc editor above its fields, and the Build tab its seven fields (ST-01)", async () => {
    const { api } = fakeSettingsApi();
    render(
      <SettingsApp
        api={api}
        initial={defaultSettings()}
        npmrcEditorFactory={async () => ({
          getValue: () => "",
          setValue: () => {},
          onChange: () => () => {},
          dispose: () => {},
        })}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "NPM" }));
    expect(await screen.findByRole("button", { name: strings.settings.npmrc.reset })).toBeTruthy();
    expect(screen.getByLabelText("Allow Install Scripts")).toBeTruthy();
    expect(api.getNpmrc).toHaveBeenCalledTimes(1);
    // R27-4: the examples disclosure is shown alongside the editor.
    expect(screen.getByText(strings.settings.npmrc.examples)).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Build" }));
    expect(screen.getByLabelText("Pipeline Operator")).toBeTruthy();
    expect(screen.queryByRole("button", { name: strings.settings.npmrc.reset })).toBeNull();
  });
});
