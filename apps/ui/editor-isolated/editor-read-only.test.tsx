import { beforeAll, describe, expect, mock, test } from "bun:test";
import { contentHash, createTab, defaultSession, defaultSettings } from "@jslab/shared";
import { act, render } from "@testing-library/react";
import { createAppStore } from "../src/state/store";
import { createFakeApi } from "../test/fake-api";

/**
 * B1 (S2): a tab whose buffer Main couldn't read shows an empty model that is NOT its file's content, so the
 * editor is put into `readOnly` for exactly as long as that is true (`Editor.tsx`'s `applyReadOnly`). Without it
 * the placeholder is typable, which is the keystroke-level half of the trap that truncated files.
 *
 * Why this file has its own directory and its own `bun test` invocation: `mock.module` is process-wide, and
 * `isolated/app.test.tsx` mocks `../src/editor/Editor` away for the whole `isolated/` run -- bun registers every
 * file's top-level mocks before running any test, so filename order cannot dodge it. Rendering the REAL Editor
 * therefore needs a process where that mock was never registered. It cannot live in `test/` either: the Monaco
 * fake below would leak into the ~50 files that share that process.
 *
 * This run logs "failed to apply the TypeScript environment: Cannot find module 'virtual:jslab-type-libs/bun'"
 * once per render. That is expected, not a failure: the runtime type packs are Vite virtual modules that only
 * `loadRuntimePack`'s dynamic import reaches, and `applyTypeScript` already catches and logs that rejection.
 */

const REAL = "export const answer = 42;\n";

/** Every `editor.updateOptions` argument from the mounted Editor, in order. Cleared before each render. */
const updates: Record<string, unknown>[] = [];

const disposable = () => ({ dispose: () => {} });

function fakeModel(value: string) {
  let text = value;
  return {
    uri: { toString: () => "file:///tab/t1.ts" },
    getValue: () => text,
    setValue: (next: string) => {
      text = next;
    },
    dispose: () => {},
    isDisposed: () => false,
    onDidChangeContent: () => disposable(),
    pushStackElement: () => {},
    pushEditOperations: () => null,
    getFullModelRange: () => ({}),
    getLanguageId: () => "typescript",
    getLineContent: () => "",
    getEOL: () => "\n",
    getLineMaxColumn: () => 1,
    getOffsetAt: () => 0,
    getPositionAt: () => ({ lineNumber: 1, column: 1 }),
  };
}

function fakeEditorInstance() {
  let model: unknown = null;
  return {
    updateOptions: (options: Record<string, unknown>) => void updates.push(options),
    // Monaco's IEditorDecorationsCollection, in full rather than the one method this test first needed: the
    // hover decorations (Editor.tsx) and M5a's logpoint gutter both drive one, and they clear/append as well as
    // set. Implementing the whole published surface ends the one-TypeError-per-run discovery loop.
    createDecorationsCollection: () => ({
      length: 0,
      set: () => {},
      clear: () => {},
      append: () => {},
      getRanges: () => [],
      getRange: () => null,
      has: () => false,
      onDidChange: () => disposable(),
    }),
    onDidChangeCursorPosition: () => disposable(),
    onDidScrollChange: () => disposable(),
    onDidFocusEditorText: () => disposable(),
    getModel: () => model,
    setModel: (next: unknown) => {
      model = next;
    },
    saveViewState: () => null,
    restoreViewState: () => {},
    getPosition: () => null,
    getSelections: () => null,
    getRawOptions: () => ({}),
    getAction: () => null,
    // M5b registers the Create Snippet… context-menu action on the real editor (snippets/create-snippet-action.ts),
    // so the fake has to offer the same surface or mounting the real Editor throws before any assertion runs.
    addAction: () => disposable(),
    // M5a's logpoint gutter attaches to the real editor at mount (editor/logpoint-gutter.ts): both of these
    // must hand back a disposable or the gutter's own cleanup throws.
    onMouseDown: () => disposable(),
    onDidChangeModelContent: () => disposable(),
    // Editor.tsx:332 casts this to `{ insert?(...) } | null` and Editor.tsx:347/352 guard on a falsy selection,
    // so null is the correct "nothing here" answer for both rather than a stub object.
    getContribution: () => null,
    getSelection: () => null,
    getValue: () => "",
    focus: () => {},
    trigger: () => {},
    pushUndoStop: () => {},
    executeEdits: () => {},
    setPosition: () => {},
    setSelection: () => {},
    setSelections: () => {},
    revealLineInCenterIfOutsideViewport: () => {},
    hasTextFocus: () => false,
    dispose: () => {},
  };
}

/** `new monaco.Range(…)` (hover decorations) and `monaco.Range.fromPositions` (the editor handle). */
class FakeRange {
  readonly positions: readonly number[];
  constructor(...positions: number[]) {
    this.positions = positions;
  }
  static fromPositions() {
    return new FakeRange();
  }
}

const tsDefaults = { setCompilerOptions: () => {}, setDiagnosticsOptions: () => {}, setExtraLibs: () => {} };

mock.module("../src/editor/monaco-setup", () => ({
  languageId: () => "typescript",
  modelUri: (tabId: string) => `file:///tab/${tabId}.ts`,
  setupMonaco: () => ({
    editor: {
      create: () => fakeEditorInstance(),
      createModel: (value: string) => fakeModel(value),
      defineTheme: () => {},
      setTheme: () => {},
      setModelMarkers: () => {},
      getModelMarkers: () => [],
      registerCommand: () => disposable(),
      // Read EAGERLY while logpoint-gutter builds its decoration options (logpoint-gutter.ts:44), so this one
      // is load-bearing at mount rather than only inside a callback.
      TrackedRangeStickiness: { NeverGrowsWhenTypingAtEdges: 1 },
      // Only compared inside the onMouseDown callback, which this fake never fires; present so the gutter's
      // handler is still well-formed if it ever is.
      MouseTargetType: { GUTTER_GLYPH_MARGIN: 2 },
      // M5b's snippet preview colorizes through the bridge Editor.tsx:150 publishes.
      colorize: async () => "",
    },
    languages: {
      registerCodeActionProvider: () => disposable(),
      registerCompletionItemProvider: () => disposable(),
      CompletionItemKind: { Module: 8 },
    },
    typescript: { typescriptDefaults: tsDefaults, javascriptDefaults: tsDefaults },
    Uri: { parse: (value: string) => ({ toString: () => value }) },
    Range: FakeRange,
    Selection: { fromPositions: () => ({}) },
    MarkerSeverity: { Error: 8, Warning: 4 },
  }),
}));

/**
 * `monaco-vim` reaches for the real Monaco bundle (`monaco-editor/esm/vs/editor/editor.api`) the moment it loads --
 * a browser/Vite artefact bun cannot resolve. `Editor.tsx` imports it through `./vim` for a feature this test never
 * turns on (Vim Keys defaults off), so only the third-party package is faked: every first-party module stays real.
 */
mock.module("monaco-vim", () => ({
  initVimMode: () => ({ on: () => {}, dispose: () => {} }),
  VimMode: { Vim: { defineRegister: () => {} } },
}));

let Editor: typeof import("../src/editor/Editor")["Editor"];
beforeAll(async () => {
  ({ Editor } = await import("../src/editor/Editor"));
});

/** The last `updateOptions` call that carried `readOnly`; the settings-driven option set never includes it. */
const lastReadOnly = () => updates.filter((options) => "readOnly" in options).at(-1);

function renderEditor(options: { unreadable: boolean }) {
  const store = createAppStore();
  const tab = createTab({ id: "t1", filePath: "/w/app.ts", lastSavedHash: contentHash(REAL) });
  store.getState().hydrate({
    settings: defaultSettings(),
    session: defaultSession(() => tab),
    // Exactly as Main leaves an unreadable tab: absent from `buffers` rather than invented as empty.
    buffers: options.unreadable ? {} : { t1: REAL },
    unreadableBuffers: options.unreadable ? ["t1"] : [],
    safeMode: { active: false, reason: null },
    versions: { app: "0", bun: "1.4.0" },
  });
  const { api } = createFakeApi();
  updates.length = 0;
  render(<Editor store={store} api={api} />);
  return store;
}

describe("a tab whose buffer couldn't be read is not typable (B1)", () => {
  test("the editor is read-only while the active tab is showing the placeholder", () => {
    renderEditor({ unreadable: true });
    expect(lastReadOnly()).toEqual({ readOnly: true });
  });

  test("a readable tab's editor is left editable", () => {
    renderEditor({ unreadable: false });
    expect(lastReadOnly()).toEqual({ readOnly: false });
  });

  test("marking the shown tab unreadable turns read-only on without a remount", () => {
    const store = renderEditor({ unreadable: false });
    expect(lastReadOnly()).toEqual({ readOnly: false });
    act(() => store.setState({ unreadableBuffers: ["t1"] }));
    expect(lastReadOnly()).toEqual({ readOnly: true });
  });
});
