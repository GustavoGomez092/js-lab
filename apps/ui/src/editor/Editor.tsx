import { getTheme } from "@jslab/themes";
import type * as Monaco from "monaco-editor";
import { useEffect, useRef } from "react";
import type { MainApi } from "../api";
import type { AppState, AppStore } from "../state/store";
import { setEditorHandle } from "./editor-handle";
import { type EditorOptions, editorOptionsFor } from "./editor-options";
import { createMarkerTracker, type EditorMarker, markersFor } from "./markers";
import { ModelCache } from "./models";
import { languageId, modelUri, setupMonaco } from "./monaco-setup";
import { installPasteGuard } from "./paste-guard";
import { createTabView } from "./tab-view";
import { defineClipboardRegister, startVim, type VimController } from "./vim";
import { createVimStatusNode } from "./vim-status";

interface EditorProps {
  store: AppStore;
  api: Pick<MainApi, "saveViewState">;
  onLargePaste?(bytes: number): Promise<boolean>;
}

/**
 * `EditorOptions.hover.enabled` is a plain boolean (its own contract, pinned by appearance.test.ts and the E2E
 * `editorOptions` snapshot); Monaco 0.56's `IEditorHoverOptions.enabled` takes `"on" | "off"` instead (an API
 * change from the boolean the brief assumed). Convert only at the two Monaco call sites.
 */
function toMonacoOptions(options: EditorOptions): Omit<Monaco.editor.IEditorOptions, "hover"> & {
  hover: { enabled: "on" | "off"; delay: number };
} {
  return { ...options, hover: { enabled: options.hover.enabled ? "on" : "off", delay: options.hover.delay } };
}

export function Editor({ store, api, onLargePaste }: EditorProps) {
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
      theme: getTheme(initial.themeId).id,
      automaticLayout: true,
      glyphMargin: true,
      fixedOverflowWidgets: true,
      scrollBeyondLastLine: false,
      ...toMonacoOptions(editorOptionsFor(initial.settings, initial.fontFallback)),
    });

    const applyMonacoTheme = (themeId: string) => {
      const theme = getTheme(themeId);
      monaco.editor.defineTheme(theme.id, theme.monaco as Monaco.editor.IStandaloneThemeData);
      monaco.editor.setTheme(theme.id);
    };
    applyMonacoTheme(initial.themeId);

    const editorContainer = host.current;
    let vim: VimController | null = null;
    // The status node is visible while Vim is on (review I-1): monaco-vim focuses an `<input>` inside it for
    // `:`/`/`, so it's created and removed with Vim itself rather than kept mounted (and hidden) permanently.
    // It's anchored from the editor's own container so createVimStatusNode can find `.app`/`.status-bar` and
    // insert it as a normal flex child that reserves its own layout space (review N-1, fix round 2).
    let vimStatus: HTMLDivElement | null = null;
    const syncVim = (enabled: boolean) => {
      if (enabled && !vim) {
        defineClipboardRegister();
        vimStatus = createVimStatusNode(editorContainer);
        vim = startVim(editor, vimStatus, (mode) => store.getState().setVimMode(mode));
      } else if (!enabled && vim) {
        vim.dispose();
        vim = null;
        vimStatus?.remove();
        vimStatus = null;
      }
    };
    syncVim(initial.settings.editor.vimKeys);

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

    const setMarkers = (markers: EditorMarker[]) => {
      const model = editor.getModel();
      if (!model) return;
      monaco.editor.setModelMarkers(
        model,
        "jslab",
        markers.map((marker) => ({
          ...marker,
          severity: marker.severity === "error" ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
        })),
      );
    };
    // A newly shown model has no markers, so it always gets the full set.
    const applyMarkers = (state: AppState) => setMarkers(markersFor(state.diagnostics, state.output));
    // Between model swaps, only entries appended since the previous batch are scanned.
    const markerTracker = createMarkerTracker();

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
        contentSubscription = model.onDidChangeContent(() => view.pushContent(tabId, model));
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
      getOptions: () => {
        const options = editor.getRawOptions();
        return {
          fontFamily: options.fontFamily,
          fontSize: options.fontSize,
          fontLigatures: options.fontLigatures,
          lineNumbers: options.lineNumbers,
          wordWrap: options.wordWrap,
          renderWhitespace: options.renderWhitespace,
          renderLineHighlight: options.renderLineHighlight,
          autoClosingBrackets: options.autoClosingBrackets,
          minimap: options.minimap?.enabled,
          hoverDelay: options.hover?.delay,
        };
      },
    });

    const removePasteGuard = installPasteGuard(
      editorContainer,
      (bytes) => onLargePaste?.(bytes) ?? Promise.resolve(true),
      (text) => {
        const selection = editor.getSelection();
        if (selection) editor.executeEdits("paste", [{ range: selection, text }]);
      },
    );

    const unsubscribe = store.subscribe((state, previous) => {
      if (state.themeId !== previous.themeId) applyMonacoTheme(state.themeId);
      if ((state.settings !== previous.settings || state.fontFallback !== previous.fontFallback) && state.settings) {
        editor.updateOptions(toMonacoOptions(editorOptionsFor(state.settings, state.fontFallback)));
        syncVim(state.settings.editor.vimKeys);
      }
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
      if (state.diagnostics !== previous.diagnostics || state.output !== previous.output) {
        const markers = markerTracker.update(state.diagnostics, state.output);
        if (markers) setMarkers(markers);
      }
    });

    view.show(initial);

    return () => {
      setEditorHandle(null);
      removePasteGuard();
      unsubscribe();
      view.saveActive();
      view.flush();
      contentSubscription?.dispose();
      cursorSubscription.dispose();
      scrollSubscription.dispose();
      focusSubscription.dispose();
      vim?.dispose();
      vimStatus?.remove();
      editor.dispose();
      models.disposeAll();
    };
  }, [store, api, onLargePaste]);

  return <div ref={host} className="editor" data-testid="editor" />;
}
