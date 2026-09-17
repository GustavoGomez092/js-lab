import { describe, expect, test } from "bun:test";
import {
  createTab,
  DEFAULT_KEYBINDINGS,
  defaultSettings,
  isCommandId,
  mergeSettings,
  resolveKeybindings,
} from "@jslab/shared";
import { listThemes } from "@jslab/themes";
import {
  buildMenu,
  commandForMenuAction,
  createMenuController,
  dispatchMenuAction,
  type MenuItem,
  menuAction,
} from "../src/main/menu";

const flatten = (items: MenuItem[]): MenuItem[] => items.flatMap((item) => [item, ...flatten(item.submenu ?? [])]);
const bindings = resolveKeybindings(DEFAULT_KEYBINDINGS, []);
const model = (overrides: Partial<Parameters<typeof buildMenu>[0]> = {}) => ({
  settings: defaultSettings(),
  activeTab: createTab({ id: "t1" }),
  bindings,
  themes: listThemes(),
  canReopen: false,
  ...overrides,
});
const byLabel = (items: MenuItem[], prefix: string) => flatten(items).find((item) => item.label?.startsWith(prefix));

describe("application menu", () => {
  test("every item action is a known command, and shortcut labels follow the effective bindings", () => {
    const items = flatten(buildMenu(model()));
    for (const item of items.filter((i) => i.action)) {
      const parsed = commandForMenuAction(item.action as string);
      expect(parsed === null ? item.action : isCommandId(parsed.command)).toBe(true);
    }
    expect(byLabel(buildMenu(model()), "Run")?.label).toBe("Run    ⌘R");
    const custom = resolveKeybindings(DEFAULT_KEYBINDINGS, [{ key: "cmd+shift+enter", command: "run.start" }]);
    expect(byLabel(buildMenu(model({ bindings: custom })), "Run")?.label).toBe("Run    ⇧⌘↩");
    expect(flatten(buildMenu(model())).map((i) => i.label?.split("    ")[0])).toEqual(
      expect.arrayContaining([
        "New Tab",
        "Open…",
        "Save As…",
        "Toggle Magic Comment",
        "Format Code",
        "Copy Debug Log",
        "Restart in Safe Mode",
      ]),
    );
  });

  test("the Edit menu offers Clear Output, wired to the output.clear command (OU-12)", () => {
    // Parity OU-12 claims the Edit → Clear Output path, which had no menu-level assertion: the item exists in
    // `menu.ts` and the command and its ⌘K binding are tested elsewhere, but nothing proved the menu reaches it.
    expect(byLabel(buildMenu(model()), "Clear Output")).toMatchObject({ action: menuAction("output.clear") });
  });

  test("Edit lists Toggle Logpoint and Clear All Logpoints with their chords (spec §7.4)", () => {
    const menu = buildMenu(model());
    expect(byLabel(menu, "Toggle Logpoint")?.label).toBe("Toggle Logpoint    F9");
    expect(byLabel(menu, "Clear All Logpoints")?.label).toBe("Clear All Logpoints    ⇧⌘F9");
    expect(byLabel(menu, "Toggle Logpoint")?.action).toBe(menuAction("edit.toggleLogpoint"));
    const labels = flatten(menu).map((item) => item.label?.split("    ")[0]);
    // Spec §7.4 orders them right after Toggle Magic Comment.
    expect(labels.indexOf("Toggle Logpoint")).toBe(labels.indexOf("Toggle Magic Comment") + 1);
    expect(labels.indexOf("Clear All Logpoints")).toBe(labels.indexOf("Toggle Logpoint") + 1);
  });

  test("the View menu offers the Web View tile toggle, checked and enabled from the active tab (WV-01, TF-19)", () => {
    const withTile = (runtime: "browser" | "bun", webviewVisible: boolean) => {
      const tab = createTab({ id: "t1", runtime });
      return {
        ...tab,
        layout: { ...tab.layout, tiles: { ...tab.layout.tiles, webviewVisible } },
      };
    };
    expect(byLabel(buildMenu(model({ activeTab: withTile("browser", true) })), "Web View")).toMatchObject({
      action: menuAction("view.toggleWebView"),
      checked: true,
      enabled: true,
    });
    // A bun tab can never host a webview, so the item is there but disabled -- exactly like the status-bar button.
    expect(byLabel(buildMenu(model({ activeTab: withTile("bun", true) })), "Web View")).toMatchObject({
      checked: false,
      enabled: false,
    });
  });

  test("keeps native roles, never the delete role, and accelerators only for Quit and Hide", () => {
    const items = flatten(buildMenu(model()));
    for (const role of [
      "about",
      "hide",
      "quit",
      "undo",
      "redo",
      "cut",
      "copy",
      "paste",
      "selectAll",
      "minimize",
      "zoom",
      "bringAllToFront",
    ]) {
      expect(items.some((item) => item.role === role)).toBe(true);
    }
    expect(items.some((item) => (item.role as string | undefined) === "delete")).toBe(false);
    expect(items.filter((item) => item.accelerator).map((item) => [item.role, item.accelerator])).toEqual([
      ["hide", "h"],
      ["quit", "q"],
    ]);
  });

  test("checked and enabled states follow settings, the active tab and the closed stack", () => {
    const settings = mergeSettings(defaultSettings(), { appearance: { theme: "nord" }, view: { statusBar: false } });
    const tab = createTab({
      id: "t1",
      language: "jsx",
      runtime: "bun",
      layout: {
        orientation: "vertical",
        editorSize: 55,
        outputVisible: false,
        tiles: { arrangement: "stacked", order: ["console", "webview"], webviewVisible: false, consoleSize: 55 },
        muted: false,
      },
    });
    const menu = buildMenu(model({ settings, activeTab: tab, canReopen: true }));
    expect(byLabel(menu, "Nord")?.checked).toBe(true);
    expect(byLabel(menu, "Graphite")?.checked).toBe(false);
    expect(byLabel(menu, "Follow System Appearance")?.checked).toBe(false);
    expect(byLabel(menu, "JSX")?.checked).toBe(true);
    expect(byLabel(menu, "Bun")).toMatchObject({ checked: true, enabled: true });
    // Every runtime is available since M4 Task 9 (AVAILABLE_RUNTIMES): the Actions -> Runtime menu enables all
    // three, same as the status bar's own runtime selector.
    expect(byLabel(menu, "Browser & Node APIs")).toMatchObject({ checked: false, enabled: true });
    expect(byLabel(menu, "Output")?.checked).toBe(false);
    expect(byLabel(menu, "Status Bar")?.checked).toBe(false);
    expect(byLabel(menu, "Vertical")?.checked).toBe(true);
    expect(byLabel(menu, "Reopen Closed Tab")?.enabled).toBe(true);
    expect(byLabel(buildMenu(model()), "Reopen Closed Tab")?.enabled).toBe(false);
  });

  test("menu actions round-trip commands and theme arguments, and reject anything else", () => {
    expect(commandForMenuAction(menuAction("run.start"))).toEqual({ command: "run.start" });
    expect(commandForMenuAction(menuAction("theme.select", "dracula"))).toEqual({
      command: "theme.select",
      args: { themeId: "dracula" },
    });
    expect(commandForMenuAction("command:rm.rf")).toBeNull();
    expect(commandForMenuAction("jslab:run")).toBeNull();
    expect(commandForMenuAction("command:run.start:extra")).toBeNull();
  });

  test("the controller debounces rebuilds and applies only changed menus", async () => {
    let checked = false;
    const applied: MenuItem[][] = [];
    const controller = createMenuController({
      build: () => [{ label: "X", action: menuAction("run.start"), checked }],
      apply: (menu) => applied.push(menu),
      delayMs: 5,
    });
    controller.refresh();
    controller.refresh();
    await Bun.sleep(15);
    controller.refresh();
    await Bun.sleep(15);
    checked = true;
    controller.refresh();
    await Bun.sleep(15);
    expect(applied.map((menu) => menu[0]?.checked)).toEqual([false, true]);
    expect(controller.current()[0]?.checked).toBe(true);
    controller.dispose();
  });

  test("dispatchMenuAction reopens a closed window instead of sending, sends when open, opens Settings directly, and ignores unknown actions", () => {
    const calls: { opened: number; settings: number; sent: { command: string; args?: unknown }[] } = {
      opened: 0,
      settings: 0,
      sent: [],
    };
    const target = (open: boolean) => ({
      isOpen: () => open,
      open: () => {
        calls.opened += 1;
      },
      openSettings: () => {
        calls.settings += 1;
      },
      send: (command: { command: string; args?: unknown }) => {
        calls.sent.push(command);
      },
    });

    dispatchMenuAction(undefined, target(true));
    dispatchMenuAction("command:rm.rf", target(true));
    expect(calls).toEqual({ opened: 0, settings: 0, sent: [] });

    dispatchMenuAction(menuAction("run.start"), target(false));
    expect(calls).toEqual({ opened: 1, settings: 0, sent: [] });

    dispatchMenuAction(menuAction("run.start"), target(true));
    expect(calls).toEqual({ opened: 1, settings: 0, sent: [{ command: "run.start" }] });

    // Spec §7.5: JSLab → Settings… (⌘,) opens or focuses Settings whether or not the main window is open.
    dispatchMenuAction(menuAction("app.settings"), target(false));
    expect(calls).toEqual({ opened: 1, settings: 1, sent: [{ command: "run.start" }] });
    dispatchMenuAction(menuAction("app.settings"), target(true));
    expect(calls).toEqual({ opened: 1, settings: 2, sent: [{ command: "run.start" }] });
  });

  test("Actions has Set and Clear Working Directory, and Tools lists NPM Packages and Environment Variables (spec §7.4)", () => {
    const top = buildMenu(model()).map((item) => item.label);
    expect(top.indexOf("Tools")).toBe(top.indexOf("Actions") + 1);
    const withoutWd = buildMenu(model());
    expect(byLabel(withoutWd, "Set Working Directory…")?.enabled).toBe(true);
    expect(byLabel(withoutWd, "Clear Working Directory")?.enabled).toBe(false);
    const withWd = buildMenu(model({ activeTab: createTab({ id: "t1", workingDirectory: "/work/api" }) }));
    expect(byLabel(withWd, "Clear Working Directory")?.enabled).toBe(true);
    expect(byLabel(withWd, "NPM Packages…")?.label).toBe("NPM Packages…    ⌘I");
    expect(byLabel(withWd, "Environment Variables…")?.action).toBe(menuAction("tools.environmentVariables"));
  });

  test("Actions ends with Show Transpiled Output (spec §7.4)", () => {
    const menu = buildMenu(model());
    expect(byLabel(menu, "Show Transpiled Output")?.action).toBe(menuAction("view.showTranspiled"));
    const actions = menu.find((item) => item.label === "Actions")?.submenu ?? [];
    expect(actions[actions.length - 1]?.label?.split("    ")[0]).toBe("Show Transpiled Output");
  });
});
