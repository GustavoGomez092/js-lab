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
 * Fix round 2 (review N-1): inserted as a normal flex child of `.app`, directly before `.status-bar`, so it
 * takes real layout space (`.app-main` shrinks to make room) instead of a `position: fixed` bar that covered
 * the last 28px of the editor/output. `anchor` only needs to be some element inside `.app` (the editor's own
 * container works).
 *
 * Fix round 1 (review I-1): `view.statusBar: false` (Task 16) leaves `.app` with no `.status-bar` at all. The
 * node still belongs inside `.app` -- as its last flex child, via `insertBefore(node, null)` -- never in the
 * `document.body` fallback, which sits outside `.app`'s `height: 100%` flex column inside the app root's
 * `overflow: hidden`, and is therefore invisible; a `:`/`/` prompt focused there would take keystrokes the user
 * can never see. `document.body` is used only when there's no `.app` at all (an isolated test, for example).
 */
export function createVimStatusNode(anchor: Element = document.body): HTMLDivElement {
  const node = document.createElement("div");
  node.className = "vim-status";
  const app = anchor.closest(".app");
  if (app) {
    // `insertBefore(node, null)` -- when there's no `.status-bar` -- appends node as the last child, same as
    // `app.appendChild(node)`; written this way so the "before the status bar, if any" intent stays explicit.
    app.insertBefore(node, app.querySelector(".status-bar"));
  } else {
    document.body.appendChild(node);
  }
  return node;
}
