import { describe, expect, mock, test } from "bun:test";
import type { SettingsViewMessages } from "@jslab/rpc-schema";
import { COMMANDS, DEFAULT_KEYBINDINGS, type KeybindingRule } from "@jslab/shared";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { KeybindingsPane } from "../src/settings/KeybindingsPane";
import type { SettingsApi } from "../src/settings/settings-rpc";

function fakeApi(rules: KeybindingRule[] = [], options: { unregistered?: string } = {}) {
  const listeners = new Map<string, Set<(payload: never) => void>>();
  const api = {
    getKeybindings: mock(async () => ({
      rules,
      defaults: [...DEFAULT_KEYBINDINGS],
      path: "/data/keybindings.json",
    })),
    commandCatalog: mock(async () => ({
      commands: COMMANDS.map((command) => ({
        id: command.id,
        title: command.title,
        category: command.category,
        registered: command.id !== options.unregistered,
      })),
    })),
    appCommand: mock((_action: string) => {}),
    on(name: string, listener: (payload: never) => void) {
      const set = listeners.get(name) ?? new Set();
      listeners.set(name, set);
      set.add(listener);
      return () => set.delete(listener);
    },
  };
  const emit = <K extends keyof SettingsViewMessages>(name: K, payload: SettingsViewMessages[K]) =>
    act(async () => {
      for (const listener of listeners.get(name) ?? []) (listener as (value: unknown) => void)(payload);
      await Bun.sleep(1);
    });
  return { api: api as unknown as SettingsApi, appCommand: api.appCommand, emit };
}

const rowNamed = (name: RegExp) => screen.getByRole("row", { name });
const settled = () => waitFor(() => expect(screen.getAllByRole("row").length).toBeGreaterThan(COMMANDS.length - 1));

describe("KeybindingsPane", () => {
  test("renders a row per command with its chord, when-clause and source", async () => {
    const { api } = fakeApi();
    render(<KeybindingsPane api={api} />);
    await settled();
    // Header + one row for every command in the catalogue (R-M5D-REGISTRY-1).
    expect(screen.getAllByRole("row")).toHaveLength(COMMANDS.length + 1);
    const run = rowNamed(/^Run\b/);
    expect(run.textContent).toContain("⌘R");
    expect(run.textContent).toContain("Default");
    expect(rowNamed(/Toggle Line Comment/).textContent).toContain("editorFocus");
    // A command with no default binding is still listed, and says it is unbound.
    expect(rowNamed(/Toggle Loop Protection/).textContent).toContain("Not bound");
  });

  test("the search box filters the table", async () => {
    const { api } = fakeApi();
    render(<KeybindingsPane api={api} />);
    await settled();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "reopen" } });
    await waitFor(() => expect(screen.getAllByRole("row")).toHaveLength(2)); // header + one match
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "zzzz" } });
    await waitFor(() => expect(screen.getByText("No commands match this search")).toBeTruthy());
    expect(screen.getAllByRole("row")).toHaveLength(1); // the header alone
  });

  test("a user override reports User and warns about a conflict", async () => {
    const { api } = fakeApi([{ key: "cmd+r", command: "run.stop" }]);
    render(<KeybindingsPane api={api} />);
    await settled();
    expect(rowNamed(/^Stop\b/).textContent).toContain("User");
    // Named both ways, so whichever row the user is looking at says what it collides with.
    expect(rowNamed(/^Stop\b/).textContent).toContain("Also bound to Run");
    expect(rowNamed(/^Run\b/).textContent).toContain("Also bound to Stop");
  });

  test("a command the running window has not registered is listed and marked unavailable", async () => {
    const { api } = fakeApi([], { unregistered: "run.kill" });
    render(<KeybindingsPane api={api} />);
    await settled();
    expect(rowNamed(/^Kill\b/).textContent).toContain("Not available in this window");
    expect(rowNamed(/^Run\b/).textContent).not.toContain("Not available in this window");
  });

  // Finding K1: the broadcast exists precisely so an edit to keybindings.json shows up without a relaunch. If the
  // pane never subscribed, that wire would be dead and this pane would show stale bindings.
  test("a keybindings.changed broadcast updates the table in place", async () => {
    const { api, emit } = fakeApi();
    render(<KeybindingsPane api={api} />);
    await settled();
    expect(rowNamed(/^Run\b/).textContent).toContain("⌘R");
    await emit("keybindings.changed", { rules: [{ key: "cmd+shift+enter", command: "run.start" }] });
    expect(rowNamed(/^Run\b/).textContent).toContain("⇧⌘↩");
    expect(rowNamed(/^Run\b/).textContent).toContain("User");
  });

  test("Open keybindings.json asks Main to open the file (spec §6.5)", async () => {
    const { api, appCommand } = fakeApi();
    render(<KeybindingsPane api={api} />);
    await settled();
    fireEvent.click(screen.getByRole("button", { name: "Open keybindings.json" }));
    expect(appCommand).toHaveBeenCalledWith("openKeybindingsFile");
  });

  test("a failed load says so instead of showing a silently empty table", async () => {
    const { api } = fakeApi();
    (api.getKeybindings as ReturnType<typeof mock>).mockImplementationOnce(async () => {
      throw new Error("EACCES: permission denied, open '/Users/me/keybindings.json'");
    });
    render(<KeybindingsPane api={api} />);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Couldn't read the keybindings."));
    // The raw fs message can carry an absolute path, so it is never rendered (spec §18).
    expect(document.body.textContent).not.toContain("/Users/me");
  });
});
