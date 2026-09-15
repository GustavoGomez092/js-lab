/**
 * Creates the visible node monaco-vim renders its mode indicator and its `:`/`/` prompt input into (spec §6.3,
 * review I-1, fix round 1). Kept in its own module, separate from vim.ts (which eagerly `require`s `monaco-vim`,
 * and through it a `monaco-editor` deep import that only resolves under the Vite build's alias, not bun:test —
 * see vite.config.ts), so this plain DOM helper stays unit-testable without a real Monaco editor.
 *
 * Styled by the `.vim-status` rule in styles.css (Graphite tokens). Must never carry `.visually-hidden`:
 * monaco-vim focuses an `<input>` inside this node for `:`/`/`, so clipping it to 1px would send keystrokes
 * into a prompt the user can never see.
 *
 * T16-rr1: the node goes into `slot`, the React-owned `.vim-slot` App renders directly before the status bar. The slot
 * is `display: contents`, so the node is still a normal flex child of `.app` that reserves its own row (fix round 2,
 * review N-1), and because React owns the slot's position, a status bar that mounts later (View → Status Bar off,
 * then on) can't end up above the Vim prompt. `document.body` is used only when there's no slot (an isolated test).
 */
export function createVimStatusNode(slot: Element | null): HTMLDivElement {
  const node = document.createElement("div");
  node.className = "vim-status";
  (slot ?? document.body).appendChild(node);
  return node;
}
