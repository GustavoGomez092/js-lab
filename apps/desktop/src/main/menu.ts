import type { CommandId } from "@jslab/rpc-schema";

/** Shape accepted by Electrobun's `ApplicationMenu.setApplicationMenu`. */
export interface MenuItem {
  label?: string;
  role?: "undo" | "redo" | "cut" | "copy" | "paste" | "selectAll" | "close" | "quit";
  action?: string;
  accelerator?: string;
  type?: "separator";
  submenu?: MenuItem[];
}

const ACTIONS = {
  "jslab:run": "run.start",
  "jslab:stop": "run.stop",
  "jslab:kill": "run.kill",
  "jslab:clear-output": "output.clear",
  "jslab:clear-editor": "editor.clear",
} as const satisfies Record<string, CommandId>;

/**
 * M1 application menu. Shortcuts are handled by the UI keybinding code (Electrobun accelerators only support a
 * single key with Cmd, spec §4.6), so items show the shortcut in their label instead of registering an accelerator.
 * The Edit roles keep native clipboard shortcuts working inside WKWebView. The full menu (spec §7.4) lands in M2.
 */
export function buildMenu(): MenuItem[] {
  return [
    { label: "JSLab", submenu: [{ role: "quit" }] },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
        { type: "separator" },
        { label: "Clear Output    ⌘K", action: "jslab:clear-output" },
        { label: "Clear Editor", action: "jslab:clear-editor" },
      ],
    },
    {
      label: "Actions",
      submenu: [
        { label: "Run    ⌘R", action: "jslab:run" },
        { label: "Stop    ⇧⌘R", action: "jslab:stop" },
        { label: "Kill    ⌥⌘R", action: "jslab:kill" },
      ],
    },
    { label: "Window", submenu: [{ role: "close" }] },
  ];
}

export function commandForMenuAction(action: string): CommandId | null {
  return (ACTIONS as Record<string, CommandId>)[action] ?? null;
}
