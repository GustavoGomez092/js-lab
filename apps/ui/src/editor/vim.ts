import type * as Monaco from "monaco-editor";
import { initVimMode, VimMode } from "monaco-vim";
import { copyEntriesToClipboard } from "../output/copy";

export interface VimController {
  dispose(): void;
}

/** Vim Keys (spec §6.3). `onMode` receives "normal", "insert", "visual linewise", … and null after dispose. */
export function startVim(
  editor: Monaco.editor.IStandaloneCodeEditor,
  statusNode: HTMLElement,
  onMode: (mode: string | null) => void,
): VimController {
  const adapter = initVimMode(editor, statusNode);
  onMode("normal");
  adapter.on("vim-mode-change", (change) => onMode(change.subMode ? `${change.mode} ${change.subMode}` : change.mode));
  return {
    dispose() {
      adapter.dispose();
      onMode(null);
    },
  };
}

let clipboardRegisterDefined = false;

/**
 * Maps the `"+` register to the system clipboard for writes; reads return the last text yanked in JSLab.
 * Ruling R-M2-PF3: writes go through `copyEntriesToClipboard` (the sole UI path to `navigator.clipboard.writeText`,
 * global-constraints.md "output/copy.ts") rather than calling `navigator.clipboard.writeText` directly.
 */
export function defineClipboardRegister(): void {
  if (clipboardRegisterDefined) return;
  clipboardRegisterDefined = true;
  let last = "";
  const write = (text: string) => {
    void copyEntriesToClipboard(text);
  };
  VimMode.Vim.defineRegister("+", {
    setText(text) {
      last = text;
      write(last);
    },
    pushText(text) {
      last += text;
      write(last);
    },
    clear() {
      last = "";
    },
    toString() {
      return last;
    },
  });
}
