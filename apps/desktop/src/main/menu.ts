import {
  type CommandId,
  commandMeta,
  formatChord,
  isCommandId,
  isRuntimeAvailable,
  type Language,
  type ResolvedBinding,
  type Runtime,
  type Settings,
  shortcutFor,
  type TabState,
} from "@jslab/shared";
import type { ApplicationMenuItemConfig } from "electrobun/main";

export type MenuRole =
  | "about"
  | "hide"
  | "hideOthers"
  | "showAll"
  | "quit"
  | "undo"
  | "redo"
  | "cut"
  | "copy"
  | "paste"
  | "selectAll"
  | "minimize"
  | "zoom"
  | "bringAllToFront";

/**
 * One application menu entry, shaped as the devkit's `ApplicationMenuItemConfig` (`api/sdks/main/proc/native.ts`), so
 * `ApplicationMenu.setApplicationMenu` accepts a built menu directly (final review T14: the M1 `MenuItem` wasn't a
 * discriminated union and needed the `toApplicationMenuItems` adapter). Each member lists every field, so code can read
 * `label`, `role` or `submenu` on any item.
 */
export type MenuItem =
  | {
      type: "divider";
      label?: undefined;
      role?: undefined;
      action?: undefined;
      accelerator?: undefined;
      enabled?: undefined;
      checked?: undefined;
      submenu?: undefined;
    }
  | {
      type?: "normal";
      label?: string;
      role: MenuRole;
      action?: undefined;
      accelerator?: string;
      enabled?: boolean;
      checked?: boolean;
      submenu?: MenuItem[];
    }
  | {
      type?: "normal";
      label: string;
      role?: undefined;
      action?: string;
      accelerator?: string;
      enabled?: boolean;
      checked?: boolean;
      submenu?: MenuItem[];
    };

/** Fails typecheck if a built menu stops being the devkit's menu config. */
export const MENU_IS_DEVKIT_CONFIG: MenuItem[] extends ApplicationMenuItemConfig[] ? true : never = true;

export interface MenuModel {
  settings: Settings;
  activeTab: TabState | null;
  bindings: readonly ResolvedBinding[];
  themes: readonly { id: string; name: string }[];
  canReopen: boolean;
}

const PREFIX = "command:";
const separator: MenuItem = { type: "divider" };

export function menuAction(command: CommandId, arg?: string): string {
  return arg === undefined ? `${PREFIX}${command}` : `${PREFIX}${command}:${arg}`;
}

export function commandForMenuAction(action: string): { command: CommandId; args?: unknown } | null {
  if (!action.startsWith(PREFIX)) return null;
  const [command, arg, ...rest] = action.slice(PREFIX.length).split(":");
  if (!command || !isCommandId(command) || rest.length > 0) return null;
  if (arg === undefined) return { command };
  if (command === "theme.select" && /^[\w-]{1,64}$/.test(arg)) return { command, args: { themeId: arg } };
  return null;
}

/** The complete M2 menu (spec §7.4). Shortcut text comes from the effective bindings, never from accelerators (R13). */
export function buildMenu(model: MenuModel): MenuItem[] {
  const { settings, activeTab, bindings } = model;
  const item = (command: CommandId, extra: { text?: string; enabled?: boolean; checked?: boolean } = {}): MenuItem => {
    const { text, ...rest } = extra;
    const chord = shortcutFor(bindings, command);
    const title = text ?? commandMeta(command)?.title ?? command;
    return { label: chord ? `${title}    ${formatChord(chord)}` : title, action: menuAction(command), ...rest };
  };
  const runtime = (command: CommandId, value: Runtime, text: string): MenuItem =>
    item(command, { text, checked: activeTab?.runtime === value, enabled: isRuntimeAvailable(value) });
  const language = (command: CommandId, value: Language, text: string): MenuItem =>
    item(command, { text, checked: activeTab?.language === value });
  const { view, appearance } = settings;
  // spec §7.1: a `bun` tab can never host a webview, so the item shows but stays disabled, like the status-bar button.
  const webView = {
    supported: activeTab !== null && activeTab.runtime !== "bun",
    on: activeTab?.layout.tiles.webviewVisible ?? false,
  };

  return [
    {
      label: "JSLab",
      submenu: [
        { role: "about" },
        separator,
        item("app.settings"),
        separator,
        { role: "hide", accelerator: "h" },
        { role: "hideOthers" },
        { role: "showAll" },
        separator,
        { role: "quit", accelerator: "q" },
      ],
    },
    {
      label: "File",
      submenu: [
        item("tab.new"),
        item("file.open"),
        separator,
        item("file.save"),
        item("file.saveAs"),
        separator,
        item("tab.reopenClosed", { enabled: model.canReopen }),
        item("tab.close"),
        item("app.closeWindow"),
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        separator,
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
        separator,
        item("edit.find"),
        item("edit.replace"),
        item("edit.gotoLine"),
        separator,
        item("edit.toggleLineComment"),
        item("edit.toggleBlockComment"),
        item("edit.toggleMagicComment"),
        separator,
        item("output.clear"),
        item("editor.clear"),
      ],
    },
    {
      label: "Actions",
      submenu: [
        item("run.start"),
        item("run.stop"),
        item("run.kill"),
        separator,
        item("format.document"),
        separator,
        item("wd.set", { enabled: activeTab !== null }),
        item("wd.clear", { enabled: Boolean(activeTab?.workingDirectory) }),
        separator,
        {
          label: "Runtime",
          submenu: [
            runtime("runtime.browserNode", "browser-node", "Browser & Node APIs"),
            runtime("runtime.bun", "bun", "Bun"),
            runtime("runtime.browser", "browser", "Browser"),
          ],
        },
        {
          label: "Language",
          submenu: [
            language("language.typescript", "typescript", "TypeScript"),
            language("language.javascript", "javascript", "JavaScript"),
            language("language.tsx", "tsx", "TSX"),
            language("language.jsx", "jsx", "JSX"),
          ],
        },
      ],
    },
    {
      label: "Tools",
      submenu: [item("tools.npmPackages"), item("tools.environmentVariables")],
    },
    {
      label: "View",
      submenu: [
        item("view.commandPalette", { text: "Command Palette…" }),
        separator,
        item("view.zoomReset"),
        item("view.zoomIn"),
        item("view.zoomOut"),
        separator,
        item("view.toggleOutput", { text: "Output", checked: activeTab?.layout.outputVisible ?? true }),
        item("view.toggleWebView", {
          text: "Web View",
          checked: webView.supported && webView.on,
          enabled: webView.supported,
        }),
        item("view.toggleSideBar", { text: "Side Bar", checked: view.sideBar }),
        item("view.toggleActivityBar", { text: "Activity Bar", checked: view.activityBar }),
        item("view.toggleStatusBar", { text: "Status Bar", checked: view.statusBar }),
        item("view.toggleTabBar", { text: "Tab Bar", checked: view.tabBarForSingleTab }),
        {
          label: "Layout",
          submenu: [
            item("view.layoutHorizontal", {
              text: "Horizontal",
              checked: activeTab?.layout.orientation === "horizontal",
            }),
            item("view.layoutVertical", { text: "Vertical", checked: activeTab?.layout.orientation === "vertical" }),
          ],
        },
        separator,
        item("view.toggleFullScreen", { text: "Enter Full Screen" }),
      ],
    },
    {
      label: "Themes",
      submenu: [
        ...model.themes.map((theme) => ({
          label: theme.name,
          action: menuAction("theme.select", theme.id),
          checked: !appearance.followSystem && appearance.theme === theme.id,
        })),
        separator,
        item("theme.toggleFollowSystem", { checked: appearance.followSystem }),
      ],
    },
    {
      label: "Window",
      submenu: [{ role: "minimize" }, { role: "zoom" }, separator, { role: "bringAllToFront" }],
    },
    {
      label: "Help",
      submenu: [item("help.copyDebugLog"), item("help.openLogsFolder"), separator, item("help.restartSafeMode")],
    },
  ];
}

/** Debounced menu rebuilds; Electrobun re-creates the whole native menu, so identical menus are not re-applied. */
export function createMenuController(deps: { build(): MenuItem[]; apply(menu: MenuItem[]): void; delayMs?: number }) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let applied = "";
  let current: MenuItem[] = [];
  return {
    refresh() {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const menu = deps.build();
        const serialized = JSON.stringify(menu);
        current = menu;
        if (serialized === applied) return;
        applied = serialized;
        deps.apply(menu);
      }, deps.delayMs ?? 50);
    },
    current: () => current,
    dispose() {
      clearTimeout(timer);
    },
  };
}

/**
 * A menu command while the window is closed reopens the window and drops the command, because the UI isn't
 * loaded yet to run it (spec §7.4, R-M2-T22-2). Extracted so this rule has its own test rather than living only
 * in untested `index.ts` wiring. JSLab → Settings… is the exception: Main opens or focuses the Settings window
 * itself, whether or not the main window is open (spec §7.5, review m-5).
 */
export function dispatchMenuAction(
  action: string | undefined,
  target: {
    isOpen(): boolean;
    open(): void;
    openSettings(): void;
    send(command: { command: CommandId; args?: unknown }): void;
  },
): void {
  const parsed = action ? commandForMenuAction(action) : null;
  if (!parsed) return;
  if (parsed.command === "app.settings") {
    target.openSettings();
    return;
  }
  if (!target.isOpen()) {
    target.open();
    return;
  }
  target.send(parsed);
}
