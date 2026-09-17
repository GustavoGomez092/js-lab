import { getTheme } from "@jslab/themes";
import type * as Monaco from "monaco-editor";
import { type RefObject, useEffect, useRef } from "react";
import type { MainApi } from "../api";
import { createMonacoBody } from "../snippets/body-editor";
import { registerCreateSnippetAction } from "../snippets/create-snippet-action";
import { setSnippetMonaco } from "../snippets/monaco-bridge";
import { registerSnippetCompletions } from "../snippets/snippet-completions";
import type { AppState, AppStore } from "../state/store";
import { setEditorHandle } from "./editor-handle";
import { type EditorOptions, editorOptionsFor } from "./editor-options";
import { registerImportCompletions } from "./import-completions";
import { installActionsFor, registerInstallAssist } from "./install-assist";
import { attachLogpointGutter } from "./logpoint-gutter";
import { hollowLogpointLines } from "./logpoints";
import { createMarkerTracker, type EditorMarker, markersFor } from "./markers";
import { ModelCache } from "./models";
import { languageId, modelUri, setupMonaco } from "./monaco-setup";
import { installPasteGuard, pasteInto } from "./paste-guard";
import { createTabView } from "./tab-view";
import { createTsEnvironment } from "./ts-environment";
import { tsEnvironmentChanged, tsStateFor, workingDirectoryChanged } from "./ts-state";
import { createTypeFeeder } from "./type-feeder";
import { loadRuntimePack } from "./type-libs";
import { defineClipboardRegister, startVim, type VimController } from "./vim";
import { createVimStatusNode } from "./vim-status";
import { trackWidgetOcclusion } from "./widget-occlusion";

interface EditorProps {
  store: AppStore;
  api: Pick<MainApi, "saveViewState" | "packageTypes" | "localTypes">;
  onLargePaste?(bytes: number): Promise<boolean>;
  /** R23-1: routed through the npm.install command by the caller, not called on api directly. */
  onInstall?(spec: string): void;
  /** Spec §13.1: the editor context menu's Create Snippet…, routed through the snippets.create command. */
  onCreateSnippet?(): void;
  /** The React-owned `.vim-slot` before the status bar, where the Vim status node goes (T16-rr1). */
  vimSlot?: RefObject<HTMLElement | null>;
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

export function Editor({ store, api, onLargePaste, onInstall, onCreateSnippet, vimSlot }: EditorProps) {
  const host = useRef<HTMLDivElement>(null);
  // FB-m10: the paste confirm is read through a ref, so a new callback identity (for example `flows` rebuilt after a
  // formatter change) never disposes and recreates Monaco, which would lose undo history and Vim state.
  const largePaste = useRef(onLargePaste);
  largePaste.current = onLargePaste;
  // R23-1: same latest-props ref pattern, so a new onInstall identity from App never tears down Monaco.
  const install = useRef(onInstall);
  install.current = onInstall;
  // Same reason: the context-menu action is registered once per mount, so it must read the current callback rather
  // than the identity captured at registration.
  const createSnippet = useRef(onCreateSnippet);
  createSnippet.current = onCreateSnippet;

  useEffect(() => {
    const monaco = setupMonaco();
    const initial = store.getState();
    if (!host.current || !initial.settings) return;

    const models = new ModelCache<Monaco.editor.ITextModel>((tabId, language, value) =>
      monaco.editor.createModel(value, languageId(language), monaco.Uri.parse(modelUri(tabId, language))),
    );
    /**
     * M4 (user report): "IntelliSense and console log are behind the DOM render".
     *
     * `fixedOverflowWidgets: true` below lets Monaco's hover, suggest and parameter-hint widgets escape the
     * editor's own box -- including over the Output region, where a docked `<electrobun-webview>` paints above all
     * HTML regardless of `z-index` (`../shell/overlay-presence.ts`). Those widgets are not components we render and
     * Monaco 0.56 has no public widget-visibility event, so they cannot call `useOverlayPresence` the way the
     * shell's seven overlays do. `overflowWidgetsDomNode` is the public option that closes the gap: Monaco puts
     * every overflowing widget into this one node (`view.js` appends its overflowing content- and overlay-widget
     * containers here), which `trackWidgetOcclusion` then watches.
     *
     * The `monaco-editor` class mirrors Monaco's own use of this option (`multiDiffEditorWidgetImpl.js`), so widget
     * styling still resolves now that the widgets live outside the editor's own root.
     */
    const overflowWidgets = document.createElement("div");
    overflowWidgets.className = "monaco-editor jslab-overflow-widgets";
    document.body.appendChild(overflowWidgets);

    const editor = monaco.editor.create(host.current, {
      model: null,
      theme: getTheme(initial.themeId).id,
      automaticLayout: true,
      glyphMargin: true,
      fixedOverflowWidgets: true,
      overflowWidgetsDomNode: overflowWidgets,
      scrollBeyondLastLine: false,
      ...toMonacoOptions(editorOptionsFor(initial.settings, initial.fontFallback)),
    });

    // Registers overlay presence only while one of those widgets actually overlaps a docked Web View tile -- not
    // for every hover, which would blink a running tab's Web View out on nearly every keystroke. See
    // `widget-occlusion.ts`.
    const stopWidgetOcclusion = trackWidgetOcclusion({ container: overflowWidgets });

    // Spec §6.1: Monaco's TypeScript defaults are global, so they follow the shown tab.
    const tsEnvironment = createTsEnvironment({
      defaults: [monaco.typescript.typescriptDefaults, monaco.typescript.javascriptDefaults],
      loadPack: loadRuntimePack,
    });
    const applyTypeScript = (state: AppState) => {
      const next = tsStateFor(state);
      if (next) {
        tsEnvironment
          .apply(next)
          .catch((error: unknown) => console.error("[editor] failed to apply the TypeScript environment", error));
      }
    };

    // Spec §6.2: package and working-directory types for the imports in the shown model.
    const feeder = createTypeFeeder({
      requestPackages: (tabId, names) => api.packageTypes(tabId, names),
      requestLocal: (tabId, specifiers) => api.localTypes(tabId, specifiers),
      environment: tsEnvironment,
      log: (message, detail) => console.warn(`[jslab] ${message}`, detail),
    });
    const feed = (tabId: string, model: Monaco.editor.ITextModel, options?: { immediate?: boolean }) =>
      feeder.schedule(tabId, model.getValue(), Boolean(store.getState().tabs[tabId]?.workingDirectory), options);
    const installAssist = registerInstallAssist(monaco, {
      untyped: () => feeder.untyped(),
      install: (spec) => install.current?.(spec),
    });
    // Installed packages offered inside an import/require specifier. Registered here in the same mount-scoped
    // effect as the install assist above -- never in a render path, which would stack a duplicate provider on
    // every re-render -- and read from the store per keystroke, so an install or remove needs no re-registration.
    const importCompletions = registerImportCompletions(monaco, {
      installed: () => store.getState().npm.installed,
    });
    // Spec §13.3: the snippet suggest channel. The library is read from the store at completion time, so a snippet
    // created a moment ago is suggested without re-registering anything.
    const snippetCompletions = registerSnippetCompletions(monaco, {
      snippets: () => store.getState().snippets,
    });
    const createSnippetAction = registerCreateSnippetAction(editor, { run: () => createSnippet.current?.() });
    // Spec §13.1: the panel's preview highlighting and the form's body editor both need Monaco; publish them the
    // same way the editor handle itself is published, so App keeps no import path to monaco-editor.
    setSnippetMonaco({
      colorize: (code, language) => monaco.editor.colorize(code, languageId(language ?? "typescript"), {}),
      createBody: createMonacoBody(monaco, (language) => languageId(language ?? "typescript")),
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
    // It goes into App's React-owned `.vim-slot` before the status bar (T16-rr1).
    let vimStatus: HTMLDivElement | null = null;
    const syncVim = (enabled: boolean) => {
      if (enabled && !vim) {
        defineClipboardRegister();
        vimStatus = createVimStatusNode(vimSlot?.current ?? null);
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

    // Spec §6.3: the logpoint glyph margin. `glyphMargin: true` is already set in the editor options above.
    // Every dep reads through `store.getState()` at call time rather than closing over a snapshot, so a render
    // driven by the subscription below always draws the state that triggered it.
    const logpoints = attachLogpointGutter(monaco, editor, {
      lines: () => store.getState().logpoints,
      hollow: () => hollowLogpointLines(store.getState().diagnostics),
      toggle: (line) => store.getState().toggleLogpoint(line),
      reconcile: (lines) => store.getState().setLogpoints(lines),
    });

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

    /**
     * B1: a tab whose buffer Main couldn't read shows an empty model that is NOT its file's content. Read-only
     * is both the guard (no keystroke can turn the placeholder into something that looks like a real edit) and
     * the signal the user actually feels when they try to type.
     *
     * Applied with `updateOptions` rather than through `editorOptionsFor`, which is the settings-driven option
     * set and is pinned field-by-field by `appearance.test.ts` and the E2E `editorOptions` snapshot.
     */
    const applyReadOnly = (state: AppState) => {
      editor.updateOptions({ readOnly: state.unreadableBuffers.includes(state.activeTabId ?? "") });
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
          view.pushContent(tabId, model);
          feed(tabId, model);
        });
        reportCursor();
        // A new model starts with no markers or decorations (as built in M1): reapply both.
        applyMarkers(store.getState());
        // The decorations collection still holds the previous model's ids here; rendering re-seeds it against the
        // model just attached, so the next edit reconciles from this tab's dots rather than the old tab's.
        logpoints.render();
        applyHover(store.getState().hoveredLine);
        applyTypeScript(store.getState());
        feed(tabId, model);
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
      getCursorLine: () => editor.getPosition()?.lineNumber ?? null,
      textBeforeCursor: () => {
        const model = editor.getModel();
        const position = editor.getPosition();
        if (!model || !position) return "";
        return model.getValueInRange(new monaco.Range(position.lineNumber, 1, position.lineNumber, position.column));
      },
      insertSnippet: (template, deleteBefore = 0) => {
        const model = editor.getModel();
        const position = editor.getPosition();
        if (!model || !position) return false;
        // `snippetController2` is Monaco's own snippet-insertion contribution; it is what the suggest widget uses
        // for an InsertAsSnippet completion. A build without it still gets plain text from the caller.
        const controller = editor.getContribution("snippetController2") as { insert?(template: string): void } | null;
        if (!controller || typeof controller.insert !== "function") return false;
        if (deleteBefore > 0) {
          const offset = model.getOffsetAt(position);
          const start = model.getPositionAt(Math.max(0, offset - deleteBefore));
          editor.pushUndoStop();
          editor.executeEdits("snippets", [{ range: monaco.Range.fromPositions(start, position), text: "" }]);
        }
        editor.focus();
        controller.insert(template);
        return true;
      },
      selectedTextOrAll: () => {
        const model = editor.getModel();
        if (!model) return "";
        const selection = editor.getSelection();
        if (!selection || selection.isEmpty()) return model.getValue();
        return model.getValueInRange(selection);
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
      flushViewState: () => {
        view.saveActive();
        view.flush();
      },
      typeDiagnostics: async () => {
        const model = editor.getModel();
        if (!model) return [];
        return (
          monaco.editor
            .getModelMarkers({ resource: model.uri })
            .filter((marker) => marker.owner === "typescript" || marker.owner === "javascript")
            .map((marker) => ({
              code: Number(typeof marker.code === "object" ? marker.code?.value : marker.code),
              message: marker.message,
              line: marker.startLineNumber,
            }))
            // A marker with no code becomes NaN above; drop it rather than report a nonsense code (Task 21 fix
            // round 1, N-3).
            .filter((diagnostic) => Number.isFinite(diagnostic.code))
            // Deterministic order for a future toEqual-style scenario (N-3).
            .sort((a, b) => a.line - b.line || a.code - b.code || a.message.localeCompare(b.message))
        );
      },
      completionsAt: async (offset) => {
        const model = editor.getModel();
        if (!model) return [];
        // A tab switch mid-call can detach or dispose `model` between awaits; re-check after each one rather than
        // ask the worker about a URI that no longer exists (Task 21 fix round 1, N-3).
        const isStale = () => model.isDisposed() || editor.getModel() !== model;
        const getWorker =
          model.getLanguageId() === "javascript"
            ? monaco.typescript.getJavaScriptWorker
            : monaco.typescript.getTypeScriptWorker;
        const accessor = await getWorker();
        if (isStale()) return [];
        const worker = await accessor(model.uri);
        if (isStale()) return [];
        const info = (await worker.getCompletionsAtPosition(model.uri.toString(), offset)) as
          | { entries?: { name: string }[] }
          | undefined;
        if (isStale()) return [];
        return (info?.entries ?? []).map((entry) => entry.name);
      },
      installActions: async () => {
        const model = editor.getModel();
        if (!model) return [];
        const markers = monaco.editor
          .getModelMarkers({ resource: model.uri })
          .filter((marker) => marker.owner === "typescript" || marker.owner === "javascript")
          .map((marker) => ({
            code: typeof marker.code === "object" ? marker.code.value : (marker.code ?? ""),
            message: marker.message,
          }));
        return installActionsFor(markers, feeder.untyped());
      },
    });

    // T18-m-paste: the model attached at paste time is captured, and the text goes in only if it is still attached
    // after the confirm, into every selection, as one undo step. RR2-m3: each selection then collapses to a caret
    // at the end of its inserted range, as a native paste leaves it.
    const removePasteGuard = installPasteGuard(
      editorContainer,
      (bytes) => largePaste.current?.(bytes) ?? Promise.resolve(true),
      () => editor.getModel(),
      (text, model) =>
        void pasteInto(editor, model, text, (insertedRange) =>
          monaco.Selection.fromPositions({
            lineNumber: insertedRange.endLineNumber,
            column: insertedRange.endColumn,
          }),
        ),
    );

    const unsubscribe = store.subscribe((state, previous) => {
      if (state.themeId !== previous.themeId) applyMonacoTheme(state.themeId);
      if ((state.settings !== previous.settings || state.fontFallback !== previous.fontFallback) && state.settings) {
        editor.updateOptions(toMonacoOptions(editorOptionsFor(state.settings, state.fontFallback)));
        syncVim(state.settings.editor.vimKeys);
      }
      // Task 21 fix round 1 (N-1): `tabId` is deliberately not compared here. A tab switch always reaches `onShown`
      // below (a different tab always has a different Monaco model), which already calls `applyTypeScript`, so
      // comparing `activeTabId` here only applied it twice per switch.
      if (tsEnvironmentChanged(state, previous)) {
        applyTypeScript(state);
      }
      // Task 23 fix round 2, I-1: workingDirectoryChanged only fires for the *same* active tab's own working
      // directory actually changing — a tab switch between tabs whose WDs differ is never a WD change (handled
      // below instead, where it invalidates nothing).
      if (workingDirectoryChanged(state, previous) && state.activeTabId) {
        feeder.invalidateLocal(state.activeTabId);
        feeder.invalidatePackages();
        const model = editor.getModel();
        if (model) feed(state.activeTabId, model, { immediate: true });
      } else if (state.packagesRevision !== previous.packagesRevision) {
        feeder.invalidatePackages();
        const model = editor.getModel();
        if (state.activeTabId && model) feed(state.activeTabId, model);
      }
      if (
        state.activeTabId !== previous.activeTabId ||
        state.tabs !== previous.tabs ||
        state.buffers !== previous.buffers
      ) {
        view.show(state);
      }
      // Task 23 fix round 2, I-1: a genuine tab switch invalidates nothing — the newly shown tab's local and
      // package caches are still valid — but feeds immediately. `view.show`'s `onShown` just scheduled a debounced
      // feed for the newly shown model; immediate mode cancels that timer and feeds right away instead, so the tab
      // doesn't show false "Cannot find module" markers for the 500 ms the debounce would otherwise wait out.
      if (state.activeTabId !== previous.activeTabId && state.activeTabId) {
        const model = editor.getModel();
        if (model) feed(state.activeTabId, model, { immediate: true });
      }
      if (state.tabOrder !== previous.tabOrder) {
        for (const closed of models.prune(new Set(state.tabOrder))) {
          view.cancel(closed);
          // Task 23 fix round 2, M-1: release a closed tab's local type files and cancel any pending feed for it.
          feeder.forget(closed);
        }
      }
      if (state.activeTabId !== previous.activeTabId || state.unreadableBuffers !== previous.unreadableBuffers) {
        applyReadOnly(state);
      }
      if (state.hoveredLine !== previous.hoveredLine) applyHover(state.hoveredLine);
      // A logpoint set change (a toggle, a clear, a tab switch) or a new run's diagnostics (which decide
      // filled vs hollow) both change what the margin should draw.
      if (state.logpoints !== previous.logpoints || state.diagnostics !== previous.diagnostics) {
        logpoints.render();
      }
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
    applyReadOnly(initial);

    return () => {
      setEditorHandle(null);
      removePasteGuard();
      logpoints.dispose();
      unsubscribe();
      view.saveActive();
      view.flush();
      contentSubscription?.dispose();
      cursorSubscription.dispose();
      scrollSubscription.dispose();
      focusSubscription.dispose();
      vim?.dispose();
      vimStatus?.remove();
      feeder.dispose();
      installAssist.dispose();
      importCompletions.dispose();
      snippetCompletions.dispose();
      createSnippetAction.dispose();
      // Before `editor.dispose()`: the panel must stop reaching into a Monaco that is going away, and fall back to
      // its plain-text preview rather than colorizing through a disposed editor.
      setSnippetMonaco(null);
      // Before `editor.dispose()`: releases any presence still held, so a tile can't stay collapsed because the
      // editor was torn down while a hover was showing over it.
      stopWidgetOcclusion();
      overflowWidgets.remove();
      editor.dispose();
      // Task 21 fix round 1 (M-2): stop a pending apply from writing this environment's stale settings into
      // Monaco's globals after this Editor is gone, before the models it was applying local files for are disposed.
      tsEnvironment.dispose();
      models.disposeAll();
    };
  }, [store, api, vimSlot]);

  return <div ref={host} className="editor" data-testid="editor" />;
}
