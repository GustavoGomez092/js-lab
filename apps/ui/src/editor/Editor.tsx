import type * as Monaco from "monaco-editor";
import { useEffect, useRef } from "react";
import type { AppStore } from "../state/store";
import { markersFor } from "./markers";
import { languageId, modelUri, setupMonaco } from "./monaco-setup";

interface EditorProps {
  store: AppStore;
}

export function Editor({ store }: EditorProps) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const monaco = setupMonaco();
    const initial = store.getState();
    if (!host.current || !initial.tab || !initial.settings) return;

    const createModel = (value: string, tabId: string, language: Parameters<typeof languageId>[0]) =>
      monaco.editor.createModel(value, languageId(language), monaco.Uri.parse(modelUri(tabId, language)));

    let model = createModel(initial.code, initial.tab.id, initial.tab.language);
    const editor = monaco.editor.create(host.current, {
      model,
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

    let applyingExternal = false;
    const listenToModel = (target: Monaco.editor.ITextModel) =>
      target.onDidChangeContent(() => {
        if (!applyingExternal) store.getState().editCode(target.getValue());
      });
    let contentSubscription = listenToModel(model);
    const hover = editor.createDecorationsCollection();

    const applyMarkers = () => {
      const state = store.getState();
      monaco.editor.setModelMarkers(
        model,
        "jslab",
        markersFor(state.diagnostics, state.output).map((marker) => ({
          ...marker,
          severity: marker.severity === "error" ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
        })),
      );
    };

    const unsubscribe = store.subscribe((state, previous) => {
      if (state.tab && previous.tab && state.tab.language !== previous.tab.language) {
        // Recreate the model so its URI extension matches the new language.
        const next = createModel(model.getValue(), state.tab.id, state.tab.language);
        contentSubscription.dispose();
        editor.setModel(next);
        model.dispose();
        model = next;
        contentSubscription = listenToModel(model);
      }
      if (state.code !== model.getValue()) {
        applyingExternal = true;
        model.setValue(state.code);
        applyingExternal = false;
      }
      if (state.hoveredLine !== previous.hoveredLine) {
        const line = state.hoveredLine;
        hover.set(
          line
            ? [{ range: new monaco.Range(line, 1, line, 1), options: { isWholeLine: true, className: "line-hover" } }]
            : [],
        );
      }
      if (state.revealRequest && state.revealRequest !== previous.revealRequest) {
        const { line } = state.revealRequest;
        editor.revealLineInCenterIfOutsideViewport(line);
        editor.setPosition({ lineNumber: line, column: 1 });
        editor.focus();
      }
      if (state.diagnostics !== previous.diagnostics || state.output !== previous.output) applyMarkers();
    });

    return () => {
      unsubscribe();
      contentSubscription.dispose();
      editor.dispose();
      model.dispose();
    };
  }, [store]);

  return <div ref={host} className="editor" data-testid="editor" />;
}
