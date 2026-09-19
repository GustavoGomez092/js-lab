import type * as Monaco from "monaco-editor";
import { strings } from "../strings";

/** Spec §13.1 / parity ED-20: Create Snippet… in the editor's own context menu. */
export function registerCreateSnippetAction(
  editor: Pick<Monaco.editor.IStandaloneCodeEditor, "addAction">,
  deps: { run(): void },
): { dispose(): void } {
  return editor.addAction({
    id: "jslab.createSnippet",
    label: strings.snippets.createAction,
    // Monaco's own modification group, just after the built-in entries, so it reads as an editor action rather
    // than something bolted on at the bottom of the menu.
    contextMenuGroupId: "1_modification",
    contextMenuOrder: 2,
    // Called through `deps.run()` rather than passed as `deps.run`, so a caller routing this through a ref sees
    // its LATEST callback -- the action is registered once per editor, and never re-registered.
    run: () => deps.run(),
  });
}
