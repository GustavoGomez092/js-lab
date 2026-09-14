/**
 * Creates the visible node monaco-vim renders its mode indicator and its `:`/`/` prompt input into (spec §6.3,
 * review I-1, fix round 1). Kept in its own module, separate from vim.ts (which eagerly `require`s `monaco-vim`,
 * and through it a `monaco-editor` deep import that only resolves under the Vite build's alias, not bun:test —
 * see vite.config.ts), so this plain DOM helper stays unit-testable without a real Monaco editor.
 *
 * Styled by the `.vim-status` rule in styles.css (Graphite tokens, pinned above the M1 status bar). Must never
 * carry `.visually-hidden`: monaco-vim focuses an `<input>` inside this node for `:`/`/`, so clipping it to 1px
 * would send keystrokes into a prompt the user can never see.
 */
export function createVimStatusNode(root: HTMLElement = document.body): HTMLDivElement {
  const node = document.createElement("div");
  node.className = "vim-status";
  root.appendChild(node);
  return node;
}
