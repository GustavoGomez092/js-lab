export type CommandCategory =
  | "run"
  | "file"
  | "tab"
  | "edit"
  | "format"
  | "view"
  | "tools"
  | "runtime"
  | "language"
  | "theme"
  | "help"
  | "app";

/** Where a command makes sense; the palette ranks and filters by it (Task 20). */
export type CommandContext = "editor" | "output" | "any";

export interface CommandMeta {
  id: string;
  category: CommandCategory;
  context?: CommandContext;
  /** False hides the command from the palette (it is still bindable and menu-dispatchable). */
  palette?: boolean;
}

/** Spec §17: the title lives in the locale catalogue, keyed by the id, so the two cannot drift apart. */
export function commandTitleKey(id: string): string {
  return `commands.${id}`;
}

/** Palette section order (Task 20). */
export const COMMAND_CATEGORY_ORDER: readonly CommandCategory[] = [
  "run",
  "file",
  "tab",
  "edit",
  "format",
  "view",
  "tools",
  "runtime",
  "language",
  "theme",
  "help",
  "app",
];

/** Every JSLab action (spec §6.5). Menus, keybindings, the palette and E2E all dispatch these ids. */
export const COMMANDS = [
  { id: "run.start", category: "run" },
  { id: "run.stop", category: "run" },
  { id: "run.kill", category: "run" },
  { id: "run.toggleAutoRun", category: "run" },
  { id: "run.toggleAutoLog", category: "run" },
  { id: "run.toggleLoopProtection", category: "run" },

  { id: "file.open", category: "file" },
  { id: "file.save", category: "file" },
  { id: "file.saveAs", category: "file" },

  { id: "tab.new", category: "tab" },
  { id: "tab.close", category: "tab" },
  { id: "tab.closeOthers", category: "tab" },
  { id: "tab.closeToRight", category: "tab" },
  { id: "tab.reopenClosed", category: "tab" },
  { id: "tab.next", category: "tab" },
  { id: "tab.previous", category: "tab" },
  { id: "tab.rename", category: "tab" },
  { id: "tab.revealInFinder", category: "tab" },
  { id: "tab.copyPath", category: "tab" },
  { id: "tab.goto1", category: "tab", palette: false },
  { id: "tab.goto2", category: "tab", palette: false },
  { id: "tab.goto3", category: "tab", palette: false },
  { id: "tab.goto4", category: "tab", palette: false },
  { id: "tab.goto5", category: "tab", palette: false },
  { id: "tab.goto6", category: "tab", palette: false },
  { id: "tab.goto7", category: "tab", palette: false },
  { id: "tab.goto8", category: "tab", palette: false },
  { id: "tab.goto9", category: "tab", palette: false },

  { id: "output.clear", category: "edit", context: "output" },
  { id: "output.copyAll", category: "edit", context: "output" },
  { id: "output.showAll", category: "edit", context: "output" },
  { id: "output.showResults", category: "edit", context: "output" },
  { id: "output.showLogs", category: "edit", context: "output" },
  { id: "output.showErrors", category: "edit", context: "output" },
  { id: "editor.clear", category: "edit", context: "editor" },
  { id: "edit.find", category: "edit", context: "editor" },
  { id: "edit.replace", category: "edit", context: "editor" },
  { id: "edit.findNext", category: "edit", context: "editor" },
  { id: "edit.findPrevious", category: "edit", context: "editor" },
  { id: "edit.gotoLine", category: "edit", context: "editor" },
  { id: "edit.toggleLineComment", category: "edit", context: "editor" },
  { id: "edit.toggleBlockComment", category: "edit", context: "editor" },
  { id: "edit.toggleMagicComment", category: "edit", context: "editor" },
  { id: "edit.toggleLogpoint", category: "edit", context: "editor" },
  { id: "edit.clearLogpoints", category: "edit", context: "editor" },
  { id: "edit.deleteLine", category: "edit", context: "editor" },
  { id: "edit.selectLine", category: "edit", context: "editor" },
  { id: "edit.splitSelectionIntoLines", category: "edit", context: "editor" },
  { id: "edit.insertLineBefore", category: "edit", context: "editor" },
  { id: "edit.insertLineAfter", category: "edit", context: "editor" },
  { id: "edit.selectNextOccurrence", category: "edit", context: "editor" },
  { id: "edit.expandSelection", category: "edit", context: "editor" },
  { id: "edit.selectToBracket", category: "edit", context: "editor" },
  { id: "edit.gotoBracket", category: "edit", context: "editor" },
  { id: "edit.moveLineUp", category: "edit", context: "editor" },
  { id: "edit.moveLineDown", category: "edit", context: "editor" },
  { id: "edit.joinLines", category: "edit", context: "editor" },
  { id: "edit.duplicateLine", category: "edit", context: "editor" },
  { id: "edit.sortLines", category: "edit", context: "editor" },
  { id: "edit.sortLinesCaseInsensitive", category: "edit", context: "editor" },
  {
    id: "edit.reverseLinesCaseInsensitive",
    category: "edit",
    context: "editor",
  },
  { id: "edit.deleteToLineStart", category: "edit", context: "editor" },
  { id: "edit.addCursorAbove", category: "edit", context: "editor" },
  { id: "edit.addCursorBelow", category: "edit", context: "editor" },
  { id: "edit.triggerSuggest", category: "edit", context: "editor" },
  { id: "edit.showHover", category: "edit", context: "editor" },
  { id: "edit.showDiagnostic", category: "edit", context: "editor" },

  { id: "format.document", category: "format", context: "editor" },

  { id: "view.commandPalette", category: "view", palette: false },
  { id: "view.zoomIn", category: "view" },
  { id: "view.zoomOut", category: "view" },
  { id: "view.zoomReset", category: "view" },
  { id: "view.toggleOutput", category: "view" },
  { id: "view.toggleWebView", category: "view" },
  { id: "view.showTranspiled", category: "view" },
  // UI item 2: the only keyboard route between the two panes. The output scroller carries tabIndex={0}, but from
  // Monaco `Tab` inserts a tab character, so nothing reached it from the keyboard. Neither command declares a
  // `context`: the palette drops editor-only commands when it is opened from the output, which would hide Focus
  // Editor from exactly the place it exists to escape.
  { id: "view.focusOutput", category: "view" },
  { id: "view.focusEditor", category: "view" },
  { id: "view.toggleSideBar", category: "view" },
  { id: "view.toggleActivityBar", category: "view" },
  { id: "view.toggleStatusBar", category: "view" },
  { id: "view.toggleTabBar", category: "view" },
  { id: "view.layoutHorizontal", category: "view" },
  { id: "view.layoutVertical", category: "view" },
  { id: "view.toggleLayout", category: "view" },
  { id: "view.toggleFullScreen", category: "view" },
  // Standard macOS window zoom: the Window ▸ Zoom item, and a double-click on the title bar row. Deliberately not
  // full screen -- zoom fills the display's *work area*, leaving the menu bar and the Dock where they are, and a
  // second zoom returns the window to the frame it had before.
  { id: "view.zoomWindow", category: "view" },

  { id: "wd.set", category: "run" },
  { id: "wd.clear", category: "run" },

  { id: "tools.npmPackages", category: "tools" },
  { id: "tools.environmentVariables", category: "tools" },
  { id: "npm.install", category: "tools", palette: false },
  { id: "tools.snippets", category: "tools" },
  { id: "snippets.import", category: "tools" },
  { id: "snippets.export", category: "tools" },
  // Category "edit" (they belong in the Edit menu and the palette's Edit section); the `snippets.` prefix keeps them
  // out of `apps/ui/test/commands.test.ts`'s "every edit.* command is implemented by createEditorCommands" rule,
  // which they could not satisfy -- both need the snippet library, which that factory has no access to.
  { id: "snippets.create", category: "edit", context: "editor" },
  { id: "snippets.expand", category: "edit", context: "editor", palette: false },

  { id: "runtime.bun", category: "runtime" },
  { id: "runtime.browserNode", category: "runtime" },
  { id: "runtime.browser", category: "runtime" },

  { id: "language.typescript", category: "language" },
  { id: "language.javascript", category: "language" },
  { id: "language.tsx", category: "language" },
  { id: "language.jsx", category: "language" },

  { id: "theme.select", category: "theme", palette: false },
  { id: "theme.import", category: "theme" },
  { id: "theme.toggleFollowSystem", category: "theme" },

  { id: "help.copyDebugLog", category: "help" },
  { id: "help.openLogsFolder", category: "help" },
  { id: "help.installCli", category: "help" },
  // The menu shows exactly one of this pair (spec §16.1), so only the install half is offered in the palette;
  // uninstall stays menu- and keybinding-dispatchable, the same way npm.install does.
  { id: "help.uninstallCli", category: "help", palette: false },
  { id: "help.restartSafeMode", category: "help" },

  { id: "app.settings", category: "app" },
  { id: "app.closeWindow", category: "app" },
  { id: "app.openDataFolder", category: "app" },
] as const satisfies readonly CommandMeta[];

export type CommandId = (typeof COMMANDS)[number]["id"];

const BY_ID = new Map<string, CommandMeta>(COMMANDS.map((command) => [command.id, command]));

export function commandMeta(id: string): CommandMeta | undefined {
  return BY_ID.get(id);
}

export function isCommandId(value: unknown): value is CommandId {
  return typeof value === "string" && BY_ID.has(value);
}
