import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  createTab,
  DEFAULT_KEYBINDINGS,
  defaultSettings,
  isCommandId,
  mergeSettings,
  resolveKeybindings,
} from "@jslab/shared";
import { listThemes } from "@jslab/themes";
import { createTranslator } from "../src/main/i18n";
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
/**
 * The real translator over the real shipped catalogue, not a stub. Every English assertion below therefore now
 * proves the whole id -> commandTitleKey -> en.json -> native menu chain, rather than just the menu's shape.
 */
const t = createTranslator({
  dir: join(import.meta.dir, "..", "..", "ui", "src", "i18n", "locales"),
  locale: "en",
});
const model = (overrides: Partial<Parameters<typeof buildMenu>[0]> = {}) => ({
  settings: defaultSettings(),
  activeTab: createTab({ id: "t1" }),
  bindings,
  themes: listThemes(),
  canReopen: false,
  cliInstalled: false,
  t,
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
      // M6: "about" is deliberately NOT here any more -- JSLab ships its own About dialog, because the native
      // panel can name neither the Bun/Electrobun versions nor the open-source notices. The assertion below
      // pins that the native role is really gone, so this is a swap rather than a silent duplication.
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
    // M6: the native About panel is gone in favour of `help.about`. Without this, dropping the role and
    // forgetting the replacement would look identical to a correct swap.
    expect(items.some((item) => (item.role as string | undefined) === "about")).toBe(false);
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
        tiles: { webviewVisible: false, consoleSize: 55 },
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

  test("the Themes menu offers Import VS Code Theme… after the theme list (spec §9.3)", () => {
    const submenu = buildMenu(model()).find((entry) => entry.label === "Themes")?.submenu ?? [];
    const labels = submenu.map((entry) => entry.label?.split("    ")[0]);
    expect(labels).toContain("Import VS Code Theme…");
    expect(submenu.find((entry) => entry.label?.startsWith("Import VS Code Theme"))?.action).toBe(
      menuAction("theme.import"),
    );
    // It belongs after every theme and before the follow-system toggle, so the themes stay one uninterrupted group
    // and the import sits with the action that changes what that group contains.
    const themes = model().themes;
    const importAt = labels.indexOf("Import VS Code Theme…");
    expect(importAt).toBeGreaterThan(labels.indexOf(themes[themes.length - 1]?.name ?? ""));
    expect(labels.indexOf("Follow System Appearance")).toBeGreaterThan(importAt);
  });

  test("Actions ends with Show Transpiled Output (spec §7.4)", () => {
    const menu = buildMenu(model());
    expect(byLabel(menu, "Show Transpiled Output")?.action).toBe(menuAction("view.showTranspiled"));
    const actions = menu.find((item) => item.label === "Actions")?.submenu ?? [];
    expect(actions[actions.length - 1]?.label?.split("    ")[0]).toBe("Show Transpiled Output");
  });

  test("Tools lists Snippets… with ⌘B, and Edit offers Create Snippet… after the logpoint items (§7.4, §13.1)", () => {
    const menu = buildMenu(model());
    expect(byLabel(menu, "Snippets…")?.label).toBe("Snippets…    ⌘B");
    expect(byLabel(menu, "Snippets…")?.action).toBe(menuAction("tools.snippets"));
    expect(byLabel(menu, "Import Snippets…")?.action).toBe(menuAction("snippets.import"));
    expect(byLabel(menu, "Export Snippets…")?.action).toBe(menuAction("snippets.export"));
    expect(byLabel(menu, "Create Snippet…")?.action).toBe(menuAction("snippets.create"));
    const labels = flatten(menu).map((item) => item.label?.split("    ")[0]);
    // M5a owns the two items above it. Create Snippet… goes AFTER them -- never between them and Toggle Magic
    // Comment, and never in place of them. The M5a test above asserts that adjacency from its side; this asserts
    // it from M5b's, so a Task 9 edit that displaces either item fails here too.
    expect(labels.indexOf("Toggle Logpoint")).toBe(labels.indexOf("Toggle Magic Comment") + 1);
    expect(labels.indexOf("Clear All Logpoints")).toBe(labels.indexOf("Toggle Logpoint") + 1);
    expect(labels.indexOf("Create Snippet…")).toBeGreaterThan(labels.indexOf("Clear All Logpoints"));
    // Create Snippet… belongs to EDIT, and the three library items to TOOLS -- a block pasted into the wrong
    // submenu keeps every assertion above true, so the owning submenu is asserted directly.
    const submenu = (label: string) =>
      (menu.find((item) => item.label === label)?.submenu ?? []).map((item) => item.label?.split("    ")[0]);
    expect(submenu("Edit")).toContain("Create Snippet…");
    expect(submenu("Tools")).toEqual([
      "NPM Packages…",
      "Environment Variables…",
      "Snippets…",
      // TL-18: AI Chat sits with the other Tools panels, above the separator that starts the snippet
      // import/export block -- so the three library items stay a group of their own.
      "AI Chat…",
      undefined,
      "Import Snippets…",
      "Export Snippets…",
    ]);
    // And M5a's Actions item is still last, which an inattentive Tools edit can push off the end.
    const actions = menu.find((item) => item.label === "Actions")?.submenu ?? [];
    expect(actions[actions.length - 1]?.label?.split("    ")[0]).toBe("Show Transpiled Output");
  });

  test("the Help menu offers one install slot whose label follows the installed state (§16.1)", () => {
    const fresh = buildMenu(model());
    expect(byLabel(fresh, "Install jslab Command")).toMatchObject({ action: menuAction("help.installCli") });
    expect(byLabel(fresh, "Uninstall jslab Command")).toBeUndefined();

    const installed = buildMenu(model({ cliInstalled: true }));
    expect(byLabel(installed, "Uninstall jslab Command")).toMatchObject({ action: menuAction("help.uninstallCli") });
    expect(byLabel(installed, "Install jslab Command")).toBeUndefined();
  });

  /**
   * ST-11 (spec §7.4). The English asserted here is a literal, not a lookup of the same catalogue entry the
   * menu read, so it pins the whole id -> commandTitleKey -> en.json -> native menu chain rather than merely
   * agreeing with itself: a renamed or deleted `commands.help.*` entry makes `t()` return the raw key and
   * these fail.
   */
  test("the Help menu carries Documentation, Report Issue and What's New, each on its command (ST-11)", () => {
    const menu = buildMenu(model());
    expect(byLabel(menu, "Documentation")).toMatchObject({ action: menuAction("help.documentation") });
    expect(byLabel(menu, "Report Issue")).toMatchObject({ action: menuAction("help.reportIssue") });
    expect(byLabel(menu, "What's New")).toMatchObject({ action: menuAction("help.whatsNew") });

    // Order matters to the reader: the three link items lead the menu, ahead of the diagnostic items. Asserted
    // on the Help submenu itself so a block pasted into another menu cannot satisfy the lookups above.
    const help = (menu.find((item) => item.label === "Help")?.submenu ?? []).map(
      (item) => item.label?.split("    ")[0],
    );
    expect(help.slice(0, 7)).toEqual([
      "About JSLab",
      undefined,
      "Documentation",
      "Report Issue",
      "What's New",
      undefined,
      "Copy Debug Log",
    ]);
  });

  /**
   * M6. About is reachable from both the app menu (where a Mac user looks for it) and the Help menu, and both
   * dispatch the one `help.about` command, so the two entry points cannot drift apart. The English is a
   * literal for the same reason the ST-11 titles above are.
   */
  test("About JSLab sits in the app menu and the Help menu, both on the one command (M6)", () => {
    const menu = buildMenu(model());
    const appMenu = menu.find((item) => item.label === "JSLab")?.submenu ?? [];
    const help = menu.find((item) => item.label === "Help")?.submenu ?? [];

    // The app menu leads with it, in the slot the native `{ role: "about" }` panel used to occupy.
    expect(appMenu[0]).toMatchObject({ label: "About JSLab", action: menuAction("help.about") });
    expect(help[0]).toMatchObject({ label: "About JSLab", action: menuAction("help.about") });
    // Exactly two entries, so a future edit cannot quietly leave a third About somewhere else in the bar.
    expect(flatten(menu).filter((item) => item.action === menuAction("help.about"))).toHaveLength(2);
  });
});
