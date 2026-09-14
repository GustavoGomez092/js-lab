declare module "monaco-vim" {
  import type * as Monaco from "monaco-editor";

  interface VimModeChange {
    mode: string;
    subMode?: string;
  }

  interface VimAdapter {
    dispose(): void;
    on(event: "vim-mode-change", listener: (change: VimModeChange) => void): void;
  }

  interface VimRegister {
    setText(text: string): void;
    pushText(text: string): void;
    clear(): void;
    toString(): string;
  }

  export function initVimMode(editor: Monaco.editor.IStandaloneCodeEditor, statusBar?: HTMLElement | null): VimAdapter;
  export const VimMode: { Vim: { defineRegister(name: string, register: VimRegister): void } };
}
