import { describe, expect, mock, test } from "bun:test";
import type { SettingsViewMessages } from "@jslab/rpc-schema";
import { COMMANDS, DEFAULT_KEYBINDINGS, type KeybindingRule } from "@jslab/shared";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { KeybindingsPane } from "../src/settings/KeybindingsPane";
import type { SettingsApi } from "../src/settings/settings-rpc";
import { strings } from "../src/strings";

const text = strings.settings.keybindings;

function fakeApi(
  rules: KeybindingRule[] = [],
  options: { unregistered?: string; invalid?: boolean; saveFails?: boolean } = {},
) {
  const listeners = new Map<string, Set<(payload: never) => void>>();
  const api = {
    getKeybindings: mock(async () => ({
      rules,
      defaults: [...DEFAULT_KEYBINDINGS],
      path: "/data/keybindings.json",
      invalid: options.invalid === true,
    })),
    saveKeybindings: mock(async (_next: KeybindingRule[]) =>
      options.saveFails === true ? { ok: false as const, error: "EACCES" } : { ok: true as const },
    ),
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
  return { api: api as unknown as SettingsApi, appCommand: api.appCommand, save: api.saveKeybindings, emit };
}

const rowNamed = (name: RegExp) => screen.getByRole("row", { name });
const button = (name: string) => screen.getByRole("button", { name });
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

  // R-M5d-ALIAS-1. Spec §6.5 lists ⌥⌘→ / ⌥⌘← as the PRIMARY bindings for Next/Previous Tab, and both chords really
  // fire. Rendering only the highest-precedence one hid them, so they could be neither discovered nor reset.
  test("a row shows every chord bound to its command, not just the leading one", async () => {
    const { api } = fakeApi();
    render(<KeybindingsPane api={api} />);
    await settled();
    expect(rowNamed(/^Next Tab\b/).textContent).toContain("⌥⌘→");
    expect(rowNamed(/^Next Tab\b/).textContent).toContain("⌃⇥");
    expect(rowNamed(/^Previous Tab\b/).textContent).toContain("⌥⌘←");
    expect(rowNamed(/^Previous Tab\b/).textContent).toContain("⌃⇧⇥");
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
    fireEvent.click(button(text.openFile));
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

  test("capturing a chord saves it, and Escape leaves the field without binding anything", async () => {
    const { api, save } = fakeApi();
    render(<KeybindingsPane api={api} />);
    await settled();
    fireEvent.click(button(text.capture("Run")));
    fireEvent.keyDown(screen.getByLabelText(text.capturing("Run")), { code: "KeyJ", metaKey: true });
    // R-M5d-ALIAS-1: the default is RETIRED by name, not merely outranked. Without the removal, ⌘R would go on
    // running Run and the row would show both keycaps after a "Change".
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith([
        { key: "cmd+r", command: "-run.start" },
        { key: "cmd+j", command: "run.start" },
      ]),
    );
    await waitFor(() => expect(rowNamed(/^Run\b/).textContent).toContain("⌘J"));
    expect(rowNamed(/^Run\b/).textContent).not.toContain("⌘R");

    fireEvent.click(button(text.capture("Stop")));
    fireEvent.keyDown(screen.getByLabelText(text.capturing("Stop")), { code: "Escape" });
    await waitFor(() => expect(screen.queryByLabelText(text.capturing("Stop"))).toBeNull());
    expect(save).toHaveBeenCalledTimes(1);
  });

  test("changing a shortcut retires EVERY default chord of that command", async () => {
    const { api, save } = fakeApi();
    render(<KeybindingsPane api={api} />);
    await settled();
    fireEvent.click(button(text.capture("Next Tab")));
    fireEvent.keyDown(screen.getByLabelText(text.capturing("Next Tab")), {
      code: "KeyN",
      metaKey: true,
      altKey: true,
    });
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith([
        { key: "cmd+alt+right", command: "-tab.next" },
        { key: "ctrl+tab", command: "-tab.next" },
        { key: "cmd+alt+n", command: "tab.next" },
      ]),
    );
    await waitFor(() => expect(rowNamed(/^Next Tab\b/).textContent).toContain("⌥⌘N"));
    expect(rowNamed(/^Next Tab\b/).textContent).not.toContain("⌃⇥");
  });

  // An editor command must stay editor-scoped through a rebind, or ⌘/ would start firing from the output pane.
  test("a capture keeps the command's when-clause", async () => {
    const { api, save } = fakeApi();
    render(<KeybindingsPane api={api} />);
    await settled();
    fireEvent.click(button(text.capture("Toggle Line Comment")));
    fireEvent.keyDown(screen.getByLabelText(text.capturing("Toggle Line Comment")), {
      code: "Semicolon",
      metaKey: true,
      altKey: true,
    });
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith([
        { key: "cmd+/", command: "-edit.toggleLineComment" },
        { key: "cmd+alt+;", command: "edit.toggleLineComment", when: "editorFocus" },
      ]),
    );
  });

  // The third way out of an armed field, after Escape and Tab: click somewhere else.
  test("clicking away disarms the capture field", async () => {
    const { api, save } = fakeApi();
    render(<KeybindingsPane api={api} />);
    await settled();
    fireEvent.click(button(text.capture("Run")));
    fireEvent.blur(screen.getByLabelText(text.capturing("Run")));
    await waitFor(() => expect(screen.queryByLabelText(text.capturing("Run"))).toBeNull());
    expect(save).not.toHaveBeenCalled();
  });

  test("a bare key is refused with a visible reason and nothing is saved", async () => {
    const { api, save } = fakeApi();
    render(<KeybindingsPane api={api} />);
    await settled();
    fireEvent.click(button(text.capture("Run")));
    fireEvent.keyDown(screen.getByLabelText(text.capturing("Run")), { code: "KeyK" });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("modifier"));
    // The field stays armed, so the user can simply press something else.
    expect(screen.getByLabelText(text.capturing("Run"))).toBeTruthy();
    expect(save).not.toHaveBeenCalled();
  });

  // The trap this guards: a field that swallows every keystroke leaves a keyboard-only user unable to leave it.
  test("bare Tab is not swallowed, so focus can still leave an armed field", async () => {
    const { api, save } = fakeApi();
    render(<KeybindingsPane api={api} />);
    await settled();
    fireEvent.click(button(text.capture("Run")));
    const field = screen.getByLabelText(text.capturing("Run"));
    // Not prevented -- the browser's own focus move still happens.
    expect(fireEvent.keyDown(field, { code: "Tab" })).toBe(true);
    expect(screen.getByLabelText(text.capturing("Run"))).toBeTruthy();
    // ...while a key the field DOES handle is prevented, so it never reaches anything underneath.
    expect(fireEvent.keyDown(field, { code: "KeyK" })).toBe(false);
    expect(save).not.toHaveBeenCalled();
  });

  test("Reset to default drops the row's user rules; Reset All needs a second click", async () => {
    const { api, save } = fakeApi([
      { key: "cmd+j", command: "run.start" },
      { key: "cmd+y", command: "run.stop" },
    ]);
    render(<KeybindingsPane api={api} />);
    await settled();
    fireEvent.click(button(text.resetRow("Run")));
    await waitFor(() => expect(save).toHaveBeenCalledWith([{ key: "cmd+y", command: "run.stop" }]));

    fireEvent.click(button(text.resetAll));
    expect(save).toHaveBeenCalledTimes(1);
    fireEvent.click(button(strings.settings.confirmReset));
    await waitFor(() => expect(save).toHaveBeenLastCalledWith([]));
  });

  test("Reset is offered only for a command keybindings.json carries a rule for", async () => {
    const { api } = fakeApi([{ key: "cmd+y", command: "run.stop" }]);
    render(<KeybindingsPane api={api} />);
    await settled();
    expect(button(text.resetRow("Stop"))).toBeTruthy();
    expect(screen.queryByRole("button", { name: text.resetRow("Run") })).toBeNull();
  });

  /**
   * The store holds NO rules when keybindings.json could not be parsed, so any save here would replace the user's
   * broken file with a set derived from nothing -- at the exact moment they opened it to repair it.
   */
  test("an unparseable keybindings.json closes every write path instead of overwriting it", async () => {
    const { api, save, appCommand } = fakeApi([], { invalid: true });
    render(<KeybindingsPane api={api} />);
    await settled();
    expect(screen.getByRole("alert").textContent).toBe(text.fileInvalid);
    expect((button(text.capture("Run")) as HTMLButtonElement).disabled).toBe(true);
    expect((button(text.resetAll) as HTMLButtonElement).disabled).toBe(true);
    // The way out stays open: Main opens the file without rewriting it.
    fireEvent.click(button(text.openFile));
    expect(appCommand).toHaveBeenCalledWith("openKeybindingsFile");
    expect(save).not.toHaveBeenCalled();
  });

  test("a failed save says so and leaves the table showing what is really bound", async () => {
    const { api } = fakeApi([], { saveFails: true });
    render(<KeybindingsPane api={api} />);
    await settled();
    fireEvent.click(button(text.capture("Run")));
    fireEvent.keyDown(screen.getByLabelText(text.capturing("Run")), { code: "KeyJ", metaKey: true });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(text.saveFailed));
    // Main did not write, so the row must not pretend otherwise.
    expect(rowNamed(/^Run\b/).textContent).toContain("⌘R");
    expect(rowNamed(/^Run\b/).textContent).not.toContain("⌘J");
  });
});
