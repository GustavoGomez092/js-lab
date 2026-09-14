import type * as Monaco from "monaco-editor";
import { useEffect, useRef } from "react";
import type { MainApi } from "../api";
import type { AppState, AppStore } from "../state/store";
import { setEditorHandle } from "./editor-handle";
import { markersFor } from "./markers";
import { ModelCache } from "./models";
import { languageId, modelUri, setupMonaco } from "./monaco-setup";
import { createTabView } from "./tab-view";

interface EditorProps {
  store: AppStore;
  api: Pick<MainApi, "saveViewState">;
}

export function Editor({ store, api }: EditorProps) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const monaco = setupMonaco();
    const initial = store.getState();
    if (!host.current || !initial.settings) return;

    const models = new ModelCache<Monaco.editor.ITextModel>((tabId, language, value) =>
      monaco.editor.createModel(value, languageId(language), monaco.Uri.parse(modelUri(tabId, language))),
    );
    const editor = monaco.editor.create(host.current, {
      model: null,
      theme: "jslab-dark",
      automaticLayout: true,
      fontFamily: `"${initial.settings.appearance.font}", ui-monospace, Menlo, monospace`,
      fontSize: initial.settings.appearance.fontSize,
      lineNumbers: initial.settings.editor.lineNumbers ? "on" : "off",
      wordWrap: initial.settings.editor.lineWrap ? "on" : "off",
      minimap: { enabled: false },
      glyphMargin: true,
      fixedOverflowWidgets: true,
      scrollBeyondLastLine: false,
    });

    let contentSubscription: Monaco.IDisposable | null = null;
    const hover = editor.createDecorationsCollection();

    const applyHover = (line: number | null) => {
      hover.set(
        line
          ? [{ range: new monaco.Range(line, 1, line, 1), options: { isWholeLine: true, className: "line-hover" } }]
          : [],
      );
    };

    const reportCursor = () => {
      const position = editor.getPosition();
      store.getState().setCursor(position ? { line: position.lineNumber, column: position.column } : null);
    };

    const applyMarkers = (state: AppState) => {
      const model = editor.getModel();
      if (!model) return;
      monaco.editor.setModelMarkers(
        model,
        "jslab",
        markersFor(state.diagnostics, state.output).map((marker) => ({
          ...marker,
          severity: marker.severity === "error" ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
        })),
      );
    };

    // Tab switching, per-tab models and view state live in tab-view.ts, which has its own unit test (review C1).
    const view = createTabView<Monaco.editor.ITextModel, Monaco.editor.ICodeEditorViewState>({
      store,
      editor,
      models,
      persist: (tabId, viewState) => api.saveViewState(tabId, viewState),
      applyExternal: (model, value) => {
        // As built (M1 T17 fix round): apply store content as an edit so undo history survives, and restore the
        // clamped cursor. pushStackElement on both sides keeps it out of the user's undo group (final review T17).
        const savedSelections = editor.getModel() === model ? editor.getSelections() : null;
        model.pushStackElement();
        model.pushEditOperations(savedSelections, [{ range: model.getFullModelRange(), text: value }], () => null);
        model.pushStackElement();
        if (!savedSelections) return;
        editor.setSelections(
          savedSelections.map((selection) => {
            const anchor = model.validatePosition({
              lineNumber: selection.selectionStartLineNumber,
              column: selection.selectionStartColumn,
            });
            const active = model.validatePosition({
              lineNumber: selection.positionLineNumber,
              column: selection.positionColumn,
            });
            return new monaco.Selection(anchor.lineNumber, anchor.column, active.lineNumber, active.column);
          }),
        );
      },
      onShown: (tabId, model) => {
        contentSubscription?.dispose();
        contentSubscription = null;
        if (!tabId || !model) return;
        contentSubscription = model.onDidChangeContent(() => {
          if (!view.applyingExternal) store.getState().editCode(model.getValue(), tabId);
        });
        reportCursor();
        // A new model starts with no markers or decorations (as built in M1): reapply both.
        applyMarkers(store.getState());
        applyHover(store.getState().hoveredLine);
      },
    });

    const cursorSubscription = editor.onDidChangeCursorPosition(() => {
      reportCursor();
      view.saveActive();
    });
    const scrollSubscription = editor.onDidScrollChange(() => view.saveActive());
    const focusSubscription = editor.onDidFocusEditorText(() => store.getState().setFocus("editor"));

    setEditorHandle({
      typeText: (text, replace) => {
        editor.focus();
        const model = editor.getModel();
        if (replace && model) editor.setSelection(model.getFullModelRange());
        editor.trigger("e2e", "type", { text });
      },
      focus: () => editor.focus(),
      hasFocus: () => editor.hasTextFocus(),
      runAction: (actionId) => {
        if (!editor.getAction(actionId)) return false;
        editor.focus();
        editor.trigger("jslab", actionId, null);
        return true;
      },
      replaceAll: (text) => {
        const model = editor.getModel();
        if (!model) return;
        editor.pushUndoStop();
        editor.executeEdits("jslab", [{ range: model.getFullModelRange(), text }]);
        editor.pushUndoStop();
      },
      getValue: () => editor.getModel()?.getValue() ?? "",
      getCursorOffset: () => {
        const model = editor.getModel();
        const position = editor.getPosition();
        return model && position ? model.getOffsetAt(position) : 0;
      },
      getSelectedLineRange: () => {
        const selection = editor.getSelection();
        if (!selection) return null;
        const endLine =
          selection.endLineNumber > selection.startLineNumber && selection.endColumn === 1
            ? selection.endLineNumber - 1
            : selection.endLineNumber;
        return { startLine: selection.startLineNumber, endLine };
      },
      getLines: (startLine, endLine) => {
        const model = editor.getModel();
        if (!model) return [];
        const lines: string[] = [];
        for (let line = startLine; line <= endLine; line++) lines.push(model.getLineContent(line));
        return lines;
      },
      replaceLines: (startLine, endLine, lines) => {
        const model = editor.getModel();
        if (!model) return;
        const range = new monaco.Range(startLine, 1, endLine, model.getLineMaxColumn(endLine));
        editor.pushUndoStop();
        editor.executeEdits("jslab", [{ range, text: lines.join(model.getEOL()) }]);
        editor.pushUndoStop();
      },
      applyOffsetEdits: (edits, cursorOffset) => {
        const model = editor.getModel();
        if (!model || edits.length === 0) return;
        const operations = edits.map((edit) => ({
          range: monaco.Range.fromPositions(model.getPositionAt(edit.start), model.getPositionAt(edit.end)),
          text: edit.text,
        }));
        editor.pushUndoStop();
        editor.executeEdits("format", operations);
        if (cursorOffset !== undefined) editor.setPosition(model.getPositionAt(cursorOffset));
        editor.pushUndoStop();
      },
      missingActions: (ids) => ids.filter((id) => !editor.getAction(id)),
    });

    const unsubscribe = store.subscribe((state, previous) => {
      if (
        state.activeTabId !== previous.activeTabId ||
        state.tabs !== previous.tabs ||
        state.buffers !== previous.buffers
      ) {
        view.show(state);
      }
      if (state.tabOrder !== previous.tabOrder) {
        for (const closed of models.prune(new Set(state.tabOrder))) view.cancel(closed);
      }
      if (state.hoveredLine !== previous.hoveredLine) applyHover(state.hoveredLine);
      if (state.revealRequest && state.revealRequest !== previous.revealRequest) {
        const { line } = state.revealRequest;
        editor.revealLineInCenterIfOutsideViewport(line);
        editor.setPosition({ lineNumber: line, column: 1 });
        editor.focus();
      }
      if (state.diagnostics !== previous.diagnostics || state.output !== previous.output) applyMarkers(state);
    });

    view.show(initial);

    return () => {
      setEditorHandle(null);
      unsubscribe();
      view.saveActive();
      view.flush();
      contentSubscription?.dispose();
      cursorSubscription.dispose();
      scrollSubscription.dispose();
      focusSubscription.dispose();
      editor.dispose();
      models.disposeAll();
    };
  }, [store, api]);

  return <div ref={host} className="editor" data-testid="editor" />;
}
