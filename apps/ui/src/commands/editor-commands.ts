import type { CommandId } from "@jslab/shared";
import type { EditorHandle } from "../editor/editor-handle";
import type { AppStore } from "../state/store";
import type { CommandSpec } from "./registry";
import { sortLinesCaseInsensitive, toggleMagicCommentLines } from "./text-edits";

/** Spec §6.5 editor commands → Monaco 0.56 action ids (verified against monaco-editor/esm/vs). */
export const EDITOR_ACTIONS = {
  "edit.find": "actions.find",
  "edit.replace": "editor.action.startFindReplaceAction",
  "edit.findNext": "editor.action.nextMatchFindAction",
  "edit.findPrevious": "editor.action.previousMatchFindAction",
  "edit.gotoLine": "editor.action.gotoLine",
  "edit.toggleLineComment": "editor.action.commentLine",
  "edit.toggleBlockComment": "editor.action.blockComment",
  "edit.deleteLine": "editor.action.deleteLines",
  "edit.selectLine": "expandLineSelection",
  "edit.splitSelectionIntoLines": "editor.action.insertCursorAtEndOfEachLineSelected",
  "edit.insertLineBefore": "editor.action.insertLineBefore",
  "edit.insertLineAfter": "editor.action.insertLineAfter",
  "edit.selectNextOccurrence": "editor.action.addSelectionToNextFindMatch",
  "edit.expandSelection": "editor.action.smartSelect.expand",
  "edit.selectToBracket": "editor.action.selectToBracket",
  "edit.gotoBracket": "editor.action.jumpToBracket",
  "edit.moveLineUp": "editor.action.moveLinesUpAction",
  "edit.moveLineDown": "editor.action.moveLinesDownAction",
  "edit.joinLines": "editor.action.joinLines",
  "edit.duplicateLine": "editor.action.copyLinesDownAction",
  "edit.sortLines": "editor.action.sortLinesAscending",
  "edit.deleteToLineStart": "deleteAllLeft",
  "edit.addCursorAbove": "editor.action.insertCursorAbove",
  "edit.addCursorBelow": "editor.action.insertCursorBelow",
  "edit.triggerSuggest": "editor.action.triggerSuggest",
  "edit.showHover": "editor.action.showHover",
  "edit.showDiagnostic": "editor.action.marker.next",
} as const satisfies Partial<Record<CommandId, string>>;

export function createEditorCommands(editor: () => EditorHandle | null, store: AppStore): CommandSpec[] {
  const isEnabled = () => editor() !== null;

  const lineEdit = (
    id: CommandId,
    transform: (lines: string[]) => string[],
    wholeBufferWhenSingleLine: boolean,
  ): CommandSpec => ({
    id,
    isEnabled,
    run: () => {
      const handle = editor();
      const range = handle?.getSelectedLineRange();
      if (!handle || !range) return;
      const lineCount = handle.getValue().split(/\r?\n/).length;
      let { startLine, endLine } = range;
      if (wholeBufferWhenSingleLine && startLine === endLine) {
        startLine = 1;
        endLine = lineCount;
      }
      // Task 12's getLines/replaceLines don't check line ranges themselves (T12-m6): clamp here so a stale
      // selection (from before an external edit shrank the buffer) never asks Monaco for an out-of-range line.
      startLine = Math.min(Math.max(startLine, 1), lineCount);
      endLine = Math.min(Math.max(endLine, 1), lineCount);
      const lines = handle.getLines(startLine, endLine);
      const next = transform(lines);
      if (next.some((line, index) => line !== lines[index])) handle.replaceLines(startLine, endLine, next);
    },
  });

  return [
    ...(Object.entries(EDITOR_ACTIONS) as [CommandId, string][]).map(
      ([id, actionId]): CommandSpec => ({
        id,
        isEnabled,
        run: () => {
          editor()?.runAction(actionId);
        },
      }),
    ),
    lineEdit("edit.toggleMagicComment", toggleMagicCommentLines, false),
    // Spec §6.3: "`F9` toggles the current line, and `Cmd+Shift+F9` clears all." These go through the registry
    // rather than an ad-hoc key listener, so the palette, the Edit menu, E2E and a user `keybindings.json` all
    // reach them, and `isEnabled` is honoured on every one of those routes.
    {
      id: "edit.toggleLogpoint",
      isEnabled,
      run: () => {
        const line = editor()?.getCursorLine();
        if (line !== null && line !== undefined) store.getState().toggleLogpoint(line);
      },
    },
    {
      id: "edit.clearLogpoints",
      isEnabled: () => store.getState().logpoints.length > 0,
      run: () => store.getState().clearLogpoints(),
    },
    lineEdit("edit.sortLinesCaseInsensitive", (lines) => sortLinesCaseInsensitive(lines, false), true),
    lineEdit("edit.reverseLinesCaseInsensitive", (lines) => sortLinesCaseInsensitive(lines, true), true),
  ];
}
