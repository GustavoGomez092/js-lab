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
  title: string;
  category: CommandCategory;
  context?: CommandContext;
  /** False hides the command from the palette (it is still bindable and menu-dispatchable). */
  palette?: boolean;
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
  { id: "run.start", title: "Run", category: "run" },
  { id: "run.stop", title: "Stop", category: "run" },
  { id: "run.kill", title: "Kill", category: "run" },
  { id: "run.toggleAutoRun", title: "Toggle Auto Run", category: "run" },
  { id: "run.toggleAutoLog", title: "Toggle Auto Log", category: "run" },
  { id: "run.toggleLoopProtection", title: "Toggle Loop Protection", category: "run" },

  { id: "file.open", title: "Open…", category: "file" },
  { id: "file.save", title: "Save", category: "file" },
  { id: "file.saveAs", title: "Save As…", category: "file" },

  { id: "tab.new", title: "New Tab", category: "tab" },
  { id: "tab.close", title: "Close Tab", category: "tab" },
  { id: "tab.closeOthers", title: "Close Other Tabs", category: "tab" },
  { id: "tab.closeToRight", title: "Close Tabs to the Right", category: "tab" },
  { id: "tab.reopenClosed", title: "Reopen Closed Tab", category: "tab" },
  { id: "tab.next", title: "Next Tab", category: "tab" },
  { id: "tab.previous", title: "Previous Tab", category: "tab" },
  { id: "tab.rename", title: "Rename Tab…", category: "tab" },
  { id: "tab.revealInFinder", title: "Reveal in Finder", category: "tab" },
  { id: "tab.copyPath", title: "Copy Path", category: "tab" },
  { id: "tab.goto1", title: "Go to Tab 1", category: "tab", palette: false },
  { id: "tab.goto2", title: "Go to Tab 2", category: "tab", palette: false },
  { id: "tab.goto3", title: "Go to Tab 3", category: "tab", palette: false },
  { id: "tab.goto4", title: "Go to Tab 4", category: "tab", palette: false },
  { id: "tab.goto5", title: "Go to Tab 5", category: "tab", palette: false },
  { id: "tab.goto6", title: "Go to Tab 6", category: "tab", palette: false },
  { id: "tab.goto7", title: "Go to Tab 7", category: "tab", palette: false },
  { id: "tab.goto8", title: "Go to Tab 8", category: "tab", palette: false },
  { id: "tab.goto9", title: "Go to Tab 9", category: "tab", palette: false },

  { id: "output.clear", title: "Clear Output", category: "edit", context: "output" },
  { id: "output.copyAll", title: "Copy All Output", category: "edit", context: "output" },
  { id: "output.showAll", title: "Output: Show All", category: "edit", context: "output" },
  { id: "output.showResults", title: "Output: Show Results", category: "edit", context: "output" },
  { id: "output.showLogs", title: "Output: Show Logs", category: "edit", context: "output" },
  { id: "output.showErrors", title: "Output: Show Errors", category: "edit", context: "output" },
  { id: "editor.clear", title: "Clear Editor", category: "edit", context: "editor" },
  { id: "edit.find", title: "Find", category: "edit", context: "editor" },
  { id: "edit.replace", title: "Replace", category: "edit", context: "editor" },
  { id: "edit.findNext", title: "Find Next", category: "edit", context: "editor" },
  { id: "edit.findPrevious", title: "Find Previous", category: "edit", context: "editor" },
  { id: "edit.gotoLine", title: "Go to Line…", category: "edit", context: "editor" },
  { id: "edit.toggleLineComment", title: "Toggle Line Comment", category: "edit", context: "editor" },
  { id: "edit.toggleBlockComment", title: "Toggle Block Comment", category: "edit", context: "editor" },
  { id: "edit.toggleMagicComment", title: "Toggle Magic Comment", category: "edit", context: "editor" },
  { id: "edit.toggleLogpoint", title: "Toggle Logpoint", category: "edit", context: "editor" },
  { id: "edit.clearLogpoints", title: "Clear All Logpoints", category: "edit", context: "editor" },
  { id: "edit.deleteLine", title: "Delete Line", category: "edit", context: "editor" },
  { id: "edit.selectLine", title: "Select Line", category: "edit", context: "editor" },
  { id: "edit.splitSelectionIntoLines", title: "Split Selection into Lines", category: "edit", context: "editor" },
  { id: "edit.insertLineBefore", title: "Insert Line Before", category: "edit", context: "editor" },
  { id: "edit.insertLineAfter", title: "Insert Line After", category: "edit", context: "editor" },
  { id: "edit.selectNextOccurrence", title: "Select Next Occurrence", category: "edit", context: "editor" },
  { id: "edit.expandSelection", title: "Expand Selection", category: "edit", context: "editor" },
  { id: "edit.selectToBracket", title: "Select to Bracket", category: "edit", context: "editor" },
  { id: "edit.gotoBracket", title: "Go to Bracket", category: "edit", context: "editor" },
  { id: "edit.moveLineUp", title: "Move Line Up", category: "edit", context: "editor" },
  { id: "edit.moveLineDown", title: "Move Line Down", category: "edit", context: "editor" },
  { id: "edit.joinLines", title: "Join Lines", category: "edit", context: "editor" },
  { id: "edit.duplicateLine", title: "Duplicate Line", category: "edit", context: "editor" },
  { id: "edit.sortLines", title: "Sort Lines", category: "edit", context: "editor" },
  { id: "edit.sortLinesCaseInsensitive", title: "Sort Lines (Case-Insensitive)", category: "edit", context: "editor" },
  {
    id: "edit.reverseLinesCaseInsensitive",
    title: "Reverse Sort Lines (Case-Insensitive)",
    category: "edit",
    context: "editor",
  },
  { id: "edit.deleteToLineStart", title: "Delete to Line Start", category: "edit", context: "editor" },
  { id: "edit.addCursorAbove", title: "Add Cursor Above", category: "edit", context: "editor" },
  { id: "edit.addCursorBelow", title: "Add Cursor Below", category: "edit", context: "editor" },
  { id: "edit.triggerSuggest", title: "Trigger Suggestions", category: "edit", context: "editor" },
  { id: "edit.showHover", title: "Show Hover", category: "edit", context: "editor" },
  { id: "edit.showDiagnostic", title: "Show Diagnostic", category: "edit", context: "editor" },

  { id: "format.document", title: "Format Code", category: "format", context: "editor" },

  { id: "view.commandPalette", title: "Show Command Palette", category: "view", palette: false },
  { id: "view.zoomIn", title: "Zoom In", category: "view" },
  { id: "view.zoomOut", title: "Zoom Out", category: "view" },
  { id: "view.zoomReset", title: "Actual Size", category: "view" },
  { id: "view.toggleOutput", title: "Toggle Output Panel", category: "view" },
  { id: "view.toggleWebView", title: "Toggle Web View", category: "view" },
  { id: "view.showTranspiled", title: "Show Transpiled Output", category: "view" },
  { id: "view.toggleSideBar", title: "Toggle Side Bar", category: "view" },
  { id: "view.toggleActivityBar", title: "Toggle Activity Bar", category: "view" },
  { id: "view.toggleStatusBar", title: "Toggle Status Bar", category: "view" },
  { id: "view.toggleTabBar", title: "Toggle Tab Bar", category: "view" },
  { id: "view.layoutHorizontal", title: "Horizontal Layout", category: "view" },
  { id: "view.layoutVertical", title: "Vertical Layout", category: "view" },
  { id: "view.toggleLayout", title: "Toggle Vertical Split", category: "view" },
  { id: "view.toggleFullScreen", title: "Toggle Full Screen", category: "view" },

  { id: "wd.set", title: "Set Working Directory…", category: "run" },
  { id: "wd.clear", title: "Clear Working Directory", category: "run" },

  { id: "tools.npmPackages", title: "NPM Packages…", category: "tools" },
  { id: "tools.environmentVariables", title: "Environment Variables…", category: "tools" },
  { id: "npm.install", title: "Install Package", category: "tools", palette: false },
  { id: "tools.snippets", title: "Snippets…", category: "tools" },
  { id: "snippets.import", title: "Import Snippets…", category: "tools" },
  { id: "snippets.export", title: "Export Snippets…", category: "tools" },
  // Category "edit" (they belong in the Edit menu and the palette's Edit section); the `snippets.` prefix keeps them
  // out of `apps/ui/test/commands.test.ts`'s "every edit.* command is implemented by createEditorCommands" rule,
  // which they could not satisfy -- both need the snippet library, which that factory has no access to.
  { id: "snippets.create", title: "Create Snippet…", category: "edit", context: "editor" },
  { id: "snippets.expand", title: "Expand Snippet", category: "edit", context: "editor", palette: false },

  { id: "runtime.bun", title: "Runtime: Bun", category: "runtime" },
  { id: "runtime.browserNode", title: "Runtime: Browser & Node APIs", category: "runtime" },
  { id: "runtime.browser", title: "Runtime: Browser", category: "runtime" },

  { id: "language.typescript", title: "Language: TypeScript", category: "language" },
  { id: "language.javascript", title: "Language: JavaScript", category: "language" },
  { id: "language.tsx", title: "Language: TSX", category: "language" },
  { id: "language.jsx", title: "Language: JSX", category: "language" },

  { id: "theme.select", title: "Select Theme", category: "theme", palette: false },
  { id: "theme.toggleFollowSystem", title: "Follow System Appearance", category: "theme" },

  { id: "help.copyDebugLog", title: "Copy Debug Log", category: "help" },
  { id: "help.openLogsFolder", title: "Open Logs Folder", category: "help" },
  { id: "help.installCli", title: "Install jslab Command…", category: "help" },
  // The menu shows exactly one of this pair (spec §16.1), so only the install half is offered in the palette;
  // uninstall stays menu- and keybinding-dispatchable, the same way npm.install does.
  { id: "help.uninstallCli", title: "Uninstall jslab Command…", category: "help", palette: false },
  { id: "help.restartSafeMode", title: "Restart in Safe Mode", category: "help" },

  { id: "app.settings", title: "Settings…", category: "app" },
  { id: "app.closeWindow", title: "Close Window", category: "app" },
  { id: "app.openDataFolder", title: "Open Data Folder", category: "app" },
] as const satisfies readonly CommandMeta[];

export type CommandId = (typeof COMMANDS)[number]["id"];

const BY_ID = new Map<string, CommandMeta>(COMMANDS.map((command) => [command.id, command]));

export function commandMeta(id: string): CommandMeta | undefined {
  return BY_ID.get(id);
}

export function isCommandId(value: unknown): value is CommandId {
  return typeof value === "string" && BY_ID.has(value);
}
