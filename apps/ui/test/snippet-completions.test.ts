// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Monaco snippet syntax (`${1:url}`) is the literal subject
// of these assertions, not an un-interpolated template string. Same exemption `strings.ts` takes for `snippets.bodyHelp`.
import { describe, expect, mock, test } from "bun:test";
import type { Language, Snippet } from "@jslab/shared";
import type * as Monaco from "monaco-editor";
import { registerCreateSnippetAction } from "../src/snippets/create-snippet-action";
import { setSnippetMonaco, snippetBodyFactory, snippetColorize } from "../src/snippets/monaco-bridge";
import { registerSnippetCompletions } from "../src/snippets/snippet-completions";
import { strings } from "../src/strings";

const AT = "2026-09-16T10:00:00.000Z";
const snippet = (name: string, body: string, description = `does ${name}`): Snippet => ({
  id: name,
  name,
  description,
  body,
  language: null,
  createdAt: AT,
  updatedAt: AT,
});
/**
 * Deliberately NOT in name order, and the shorter name is NOT first: `completionsFor` sorts, so a fixture written
 * in the order the code happens to emit would disarm every ordering assertion made against it.
 */
const library = [
  snippet("fetchjson", "await fetch(${1:url})$0"),
  snippet("fetch", "fetch()"),
  snippet("log", "log($0)"),
];

const NUL = String.fromCharCode(0);

interface Suggestion {
  label: string;
  detail: string;
  documentation: { value: string };
  insertText: string;
  insertTextRules: number;
  kind: number;
  sortText: string;
  range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number };
}

interface ValueRange {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

/** Just enough Monaco for `registerSnippetCompletions`, in the style of `install-assist.test.ts`. */
function fakeMonaco() {
  let provider: { provideCompletionItems(model: unknown, position: unknown): { suggestions: Suggestion[] } } | null =
    null;
  let selector: unknown = null;
  let asked: ValueRange | null = null;
  const disposed = mock(() => {});
  const monaco = {
    languages: {
      CompletionItemKind: { Snippet: 27 },
      CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
      registerCompletionItemProvider: (given: unknown, p: typeof provider) => {
        selector = given;
        provider = p;
        return { dispose: disposed };
      },
    },
    Range: class {
      constructor(
        readonly startLineNumber: number,
        readonly startColumn: number,
        readonly endLineNumber: number,
        readonly endColumn: number,
      ) {}
    },
  } as unknown as typeof Monaco;

  /** Drives the captured provider with a single line of text and a caret at its end, on `lineNumber`. */
  const complete = (line: string, lineNumber = 1) => {
    const model = {
      getValueInRange: (range: ValueRange) => {
        asked = range;
        return line;
      },
    };
    const position = { lineNumber, column: line.length + 1 };
    return provider?.provideCompletionItems(model, position).suggestions ?? [];
  };
  return { monaco, complete, disposed, languages: () => selector, asked: () => asked };
}

describe("snippet completions (spec §13.3, ruling R-M5b-7)", () => {
  test("registers for both TypeScript and JavaScript, which is every language JSLab maps onto", () => {
    const { monaco, languages } = fakeMonaco();
    registerSnippetCompletions(monaco, { snippets: () => library });
    expect(languages()).toEqual(["typescript", "javascript"]);
  });

  test("suggests snippets whose name starts with the typed word, with a snippet kind, description and body", () => {
    const { monaco, complete } = fakeMonaco();
    registerSnippetCompletions(monaco, { snippets: () => library });
    const suggestions = complete("const x = fe");
    expect(suggestions.map((s) => s.label)).toEqual(["fetch", "fetchjson"]);
    expect(suggestions[0]).toMatchObject({
      kind: 27,
      insertTextRules: 4,
      detail: "does fetch",
      // The body is what the suggest widget's details pane shows; dropping it leaves the user guessing.
      documentation: { value: "fetch()" },
    });
    // The typed word is what gets replaced: "fe" is two characters before the caret at column 13.
    expect([suggestions[0]?.range.startColumn, suggestions[0]?.range.endColumn]).toEqual([11, 13]);
  });

  test("replaces the typed word on the caret's OWN line, reading only the text before the caret", () => {
    const { monaco, complete, asked } = fakeMonaco();
    registerSnippetCompletions(monaco, { snippets: () => library });
    const suggestions = complete("const x = fe", 7);
    // A provider that hardcoded line 1 would corrupt every edit made below the first line.
    expect(suggestions[0]?.range).toMatchObject({
      startLineNumber: 7,
      endLineNumber: 7,
      startColumn: 11,
      endColumn: 13,
    });
    // ...and it must ask the model only for column 1 -> the caret. Reading the WHOLE line would take its trailing
    // text as the trigger word, so `fe|ch()` would suggest against "ch()" instead of "fe".
    expect(asked()).toEqual({ startLineNumber: 7, startColumn: 1, endLineNumber: 7, endColumn: 13 });
  });

  test("the body is inserted as a template, with $ escaped when there are no placeholders (§13.2)", () => {
    // BOTH directions (ruling R-M5b-D1): a literal `$5` must survive, and a real tab stop must not be escaped.
    const { monaco, complete } = fakeMonaco();
    registerSnippetCompletions(monaco, { snippets: () => [snippet("cost", "total: $5")] });
    expect(complete("co")[0]?.insertText).toBe("total: \\$5");
    const { monaco: m2, complete: c2 } = fakeMonaco();
    registerSnippetCompletions(m2, { snippets: () => library });
    expect(c2("fetchj")[0]?.insertText).toBe("await fetch(${1:url})$0");
  });

  test("a fully typed name still suggests — and suggests only itself (RunJS #488, R-M5b-7)", () => {
    const { monaco, complete } = fakeMonaco();
    registerSnippetCompletions(monaco, { snippets: () => library });
    expect(complete("fetch").map((s) => s.label)).toEqual(["fetch"]);
    expect(complete("FETCH").map((s) => s.label)).toEqual(["fetch"]);
    expect(complete("fetchjson").map((s) => s.label)).toEqual(["fetchjson"]);
  });

  test("snippets sort ahead of word suggestions, and an empty or unmatched word offers nothing", () => {
    const { monaco, complete } = fakeMonaco();
    registerSnippetCompletions(monaco, { snippets: () => library });
    // A leading NUL sorts before anything Monaco's own word-based suggestions produce, and the zero-padded index
    // preserves `completionsFor`'s order within the bucket. Asserted exactly: a bare index, a missing pad or a
    // dropped NUL each change this string.
    expect(complete("fe").map((s) => s.sortText)).toEqual([`${NUL}0000fetch`, `${NUL}0001fetchjson`]);
    expect(complete("")).toEqual([]);
    expect(complete("obj.")).toEqual([]);
    expect(complete("zzz")).toEqual([]);
  });

  test("the bucket's own order still holds past ten matches, where an unpadded index would invert it", () => {
    const { monaco, complete } = fakeMonaco();
    // Eleven matches is the smallest fixture that catches a bare index: "10…" sorts BEFORE "9…", so the list Monaco
    // draws stops matching the order the provider emitted. Ten or fewer snippets could never show this.
    const many = Array.from({ length: 11 }, (_, index) => snippet(`ma${String(index).padStart(2, "0")}`, "body"));
    registerSnippetCompletions(monaco, { snippets: () => many });
    const sortTexts = complete("ma").map((s) => s.sortText);
    expect(sortTexts.length).toBe(11);
    expect(sortTexts).toEqual([...sortTexts].sort());
  });

  test("the library is read at completion time, so a new snippet is suggested immediately", () => {
    const { monaco, complete } = fakeMonaco();
    let current: Snippet[] = [];
    registerSnippetCompletions(monaco, { snippets: () => current });
    expect(complete("lo")).toEqual([]);
    current = library;
    expect(complete("lo").map((s) => s.label)).toEqual(["log"]);
  });

  test("dispose releases the provider", () => {
    const { monaco, disposed } = fakeMonaco();
    registerSnippetCompletions(monaco, { snippets: () => library }).dispose();
    expect(disposed).toHaveBeenCalled();
  });
});

interface AddedAction {
  id: string;
  label: string;
  contextMenuGroupId?: string;
  contextMenuOrder?: number;
  run: () => void;
}

describe("Create Snippet… in the editor context menu (spec §13.1, parity ED-20)", () => {
  test("registers a context-menu action that dispatches the command", () => {
    const added: AddedAction[] = [];
    const dispose = mock(() => {});
    const editor = {
      addAction: (action: AddedAction) => {
        added.push(action);
        return { dispose };
      },
    };
    const run = mock(() => {});
    const registration = registerCreateSnippetAction(editor as never, { run });
    expect(added[0]?.id).toBe("jslab.createSnippet");
    // The visible half: an action registered under a blank or ad-hoc label is invisible in the menu.
    expect(added[0]?.label).toBe(strings.snippets.createAction);
    // Monaco's own modification group, just after the built-in entries -- not appended at the bottom of the menu.
    expect(added[0]?.contextMenuGroupId).toBe("1_modification");
    expect(added[0]?.contextMenuOrder).toBe(2);
    added[0]?.run();
    expect(run).toHaveBeenCalled();
    registration.dispose();
    expect(dispose).toHaveBeenCalled();
  });

  test("the action calls deps.run at INVOCATION time, not the function captured at registration", () => {
    // Editor.tsx registers this once per mount and routes it through a latest-props ref, so the action must read
    // `deps.run` when it fires rather than close over the identity it was handed.
    //
    // MEASURED: writing this as `registerCreateSnippetAction(editor, { run: () => current() })` and swapping
    // `current` -- the obvious shape -- proves NOTHING: that arrow does the late binding itself, so `run: deps.run`
    // passes it too. Replacing the property ON the deps object is what actually separates the two.
    const added: { run: () => void }[] = [];
    const editor = {
      addAction: (action: { run: () => void }) => {
        added.push(action);
        return { dispose: () => {} };
      },
    };
    const original = mock(() => {});
    const deps = { run: original };
    registerCreateSnippetAction(editor as never, deps);
    const replacement = mock(() => {});
    deps.run = replacement;
    added[0]?.run();
    expect(replacement).toHaveBeenCalled();
    expect(original).not.toHaveBeenCalled();
  });
});

describe("the Monaco bridge", () => {
  test("colorize rejects until Editor fills the slot, and forwards the language once it has", async () => {
    setSnippetMonaco(null);
    await expect(snippetColorize("const a = 1", null)).rejects.toThrow();

    const seen: [string, Language | null][] = [];
    setSnippetMonaco({
      colorize: async (code, language) => {
        seen.push([code, language]);
        return `<span>${code}</span>`;
      },
      createBody: () => ({ getValue: () => "", focus: () => {}, dispose: () => {} }),
    });
    expect(await snippetColorize("const a = 1", "tsx")).toBe("<span>const a = 1</span>");
    // The language reaches Monaco: a bridge that dropped it would highlight every snippet as the default language.
    expect(seen).toEqual([["const a = 1", "tsx"]]);

    // Editor.tsx clears the slot before `editor.dispose()`, and the panel must go back to its plain-text preview
    // rather than colorize through a Monaco that is going away.
    setSnippetMonaco(null);
    await expect(snippetColorize("const a = 1", null)).rejects.toThrow();
  });

  test("the body factory falls back to a labelled textarea while no editor is mounted, and uses Monaco's once one is", () => {
    setSnippetMonaco(null);
    const host = document.createElement("div");
    const fallback = snippetBodyFactory(host, { value: "const a = 1", language: null });
    const field = host.querySelector("textarea");
    expect(field).not.toBeNull();
    // A real, labelled editing surface rather than a dead box -- the reason `createTextareaBody` takes a label.
    expect(field?.getAttribute("aria-label")).toBe(strings.snippets.bodyLabel);
    expect(fallback.getValue()).toBe("const a = 1");
    fallback.dispose();
    expect(host.querySelector("textarea")).toBeNull();

    const monacoBody = mock((_host: HTMLElement, _options: { value: string; language: Language | null }) => ({
      getValue: () => "from monaco",
      focus: () => {},
      dispose: () => {},
    }));
    setSnippetMonaco({ colorize: async (code) => code, createBody: monacoBody });
    const mounted = document.createElement("div");
    // Ignoring the slot here would silently ship the <textarea> fallback in production -- what R-M5b-5 forbids.
    expect(snippetBodyFactory(mounted, { value: "x", language: "jsx" }).getValue()).toBe("from monaco");
    // Host and options reach Monaco untouched: a bridge passing its own defaults would open an empty editor.
    expect(monacoBody).toHaveBeenCalledWith(mounted, { value: "x", language: "jsx" });
    expect(mounted.querySelector("textarea")).toBeNull();
    setSnippetMonaco(null);
  });
});
