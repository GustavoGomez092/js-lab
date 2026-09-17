import { describe, expect, test } from "bun:test";
import type { InstalledPackage } from "@jslab/rpc-schema";
import type * as Monaco from "monaco-editor";
import { importSpecifierAt, packageCompletionsFor, registerImportCompletions } from "../src/editor/import-completions";
import { strings } from "../src/strings";

/**
 * The column a caret sits at after typing everything up to (and including) `text`'s last character: Monaco columns
 * are 1-based and a caret at column N has N-1 characters before it. Used so each case below reads as "the caret is
 * right here", instead of a hand-counted magic number.
 */
function caretAfter(line: string, upTo: string): number {
  const index = line.indexOf(upTo);
  if (index < 0) throw new Error(`test setup: ${JSON.stringify(upTo)} is not in ${JSON.stringify(line)}`);
  return index + upTo.length + 1;
}

/**
 * A minimal `monaco` fake, in the shape `install-assist.test.ts` already established: enough of
 * `languages.registerCompletionItemProvider` to capture the selector and the provider, plus the one
 * `CompletionItemKind` member the provider reads. `CompletionItemKind.Module` is 8 in monaco-editor 0.56
 * (`editor.api.d.ts`), so asserting against 8 pins the real enum value, not the fake's.
 */
function fakeMonaco() {
  let selector: unknown = null;
  let provider: Monaco.languages.CompletionItemProvider | null = null;
  let disposed = 0;
  const monaco = {
    languages: {
      CompletionItemKind: { Module: 8 },
      registerCompletionItemProvider: (s: unknown, p: Monaco.languages.CompletionItemProvider) => {
        selector = s;
        provider = p;
        return {
          dispose: () => {
            disposed += 1;
          },
        };
      },
    },
  } as unknown as typeof Monaco;
  return {
    monaco,
    selector: () => selector,
    triggerCharacters: () => provider?.triggerCharacters,
    disposed: () => disposed,
    /** Drives the captured provider over a single-line model, the way Monaco calls it on a keystroke. */
    suggest: (line: string, column: number) => {
      const model = { getLineContent: (lineNumber: number) => (lineNumber === 1 ? line : "") };
      const result = provider?.provideCompletionItems(
        model as unknown as Monaco.editor.ITextModel,
        { lineNumber: 1, column } as Monaco.Position,
        {} as Monaco.languages.CompletionContext,
        {} as Monaco.CancellationToken,
      ) as Monaco.languages.CompletionList | undefined;
      return result?.suggestions ?? [];
    },
  };
}

const installed: InstalledPackage[] = [
  { name: "nanoid", version: "6.0.1", latest: null },
  { name: "zod", version: "4.6.4", latest: null },
  { name: "@scope/thing", version: "1.2.3", latest: null },
  { name: "@types/node", version: "22.20.2", latest: null },
];

describe("import specifier completions (the user report: word-based suggestions inside an import string)", () => {
  // Would fail if the trigger regex missed any one import form -- that entry would come back null.
  test("finds the typed specifier prefix inside every import form the editor supports", () => {
    const cases: [string, string][] = [
      ["import nanoId from 'na'", "'na"],
      ['import nanoId from "na"', '"na'],
      ["import type { X } from 'na'", "'na"],
      ["import 'na'", "'na"],
      ["export { x } from 'na'", "'na"],
      ["const m = await import('na')", "'na"],
      ["const m = require('na')", "'na"],
      // A multi-line import's continuation line -- just the `from` clause, no `import` keyword on this line.
      ["} from 'na'", "'na"],
    ];
    for (const [line, upTo] of cases) {
      const found = importSpecifierAt(line, caretAfter(line, upTo));
      expect({ line, found: found?.prefix }).toEqual({ line, found: "na" });
    }
  });

  // THE named boundary requirement. Would fail if the regex matched any quoted string rather than only a
  // module specifier -- which is precisely the bug that makes `const s = 'na'` offer packages.
  test("does NOT fire inside an ordinary string literal", () => {
    const cases: [string, string][] = [
      ["const s = 'na'", "'na"],
      ['const s = "na"', '"na'],
      ["console.log('na')", "'na"],
      ["foo({ key: 'na' })", "'na"],
      ["const fromage = 'na'", "'na"],
    ];
    for (const [line, upTo] of cases) {
      expect({ line, found: importSpecifierAt(line, caretAfter(line, upTo)) }).toEqual({ line, found: null });
    }
  });

  // Would fail if a `//` line comment containing the literal text of an import form were treated as a real
  // specifier -- e.g. `from` or `require(` appearing only because the line is commented out.
  test("does NOT fire inside a line comment, even one that reads like an import form", () => {
    const cases: [string, string][] = [
      ["// pulled from 'na'", "'na"],
      ["// see require('na') for details", "'na"],
    ];
    for (const [line, upTo] of cases) {
      expect({ line, found: importSpecifierAt(line, caretAfter(line, upTo)) }).toEqual({ line, found: null });
    }
  });

  // Would fail if `//` inside a string literal (not a comment) were mistaken for a comment marker, suppressing
  // a real specifier that happens to follow one on the same line.
  test("a // inside a string is not mistaken for a line comment", () => {
    const line = "const base = 'http://x'; import y from 'na'";
    expect(importSpecifierAt(line, caretAfter(line, "'na"))?.prefix).toBe("na");
  });

  // KNOWN LIMITATION, not fixed here: an ordinary prose string that happens to contain the literal substring
  // `from '` (or a template literal with `from '` after interpolation) still fires. Excluding this on a single
  // line without a real tokenizer was judged impractical relative to the (cosmetic-only) impact -- an unwanted
  // popup, never an insertion. Documented so a future attempt doesn't have to rediscover it.
  test('KNOWN LIMITATION: a prose string containing "from \'" still fires', () => {
    const cases: [string, string][] = [
      ["const msg = \"converted from 'en'\"", "'en"],
      ["const x = `${a} from 'na'`", "'na"],
    ];
    for (const [line, upTo] of cases) {
      const found = importSpecifierAt(line, caretAfter(line, upTo));
      expect({ line, found: found?.prefix }).toEqual({ line, found: line.includes("'en'") ? "en" : "na" });
    }
  });

  // Would fail if the replacement range were computed off the caret instead of the start of the typed prefix,
  // which would make accepting a suggestion duplicate or truncate what the user already typed.
  test("reports the range covering exactly the typed prefix, so accepting replaces it", () => {
    const line = "import nanoId from 'na'";
    const column = caretAfter(line, "'na");
    const found = importSpecifierAt(line, column);
    expect(found).toEqual({ prefix: "na", startColumn: column - 2 });
    // Sanity: startColumn points at the "n", i.e. just past the opening quote.
    expect(line[(found?.startColumn ?? 0) - 1]).toBe("n");
  });

  // Would fail if the empty prefix (caret right after the opening quote) were treated as "no specifier",
  // which would mean typing the quote alone offered nothing.
  test("an empty prefix right after the opening quote still counts as a specifier", () => {
    const line = "import nanoId from ''";
    expect(importSpecifierAt(line, caretAfter(line, "'"))).toEqual({ prefix: "", startColumn: caretAfter(line, "'") });
  });

  // Would fail if @types packages were offered (they are never written as a module specifier) or if the
  // prefix filter were dropped, letting every installed package show for any prefix.
  test("offers installed packages matching the prefix, never @types packages", () => {
    expect(packageCompletionsFor(installed, "na").map((p) => p.name)).toEqual(["nanoid"]);
    expect(packageCompletionsFor(installed, "").map((p) => p.name)).toEqual(["nanoid", "zod", "@scope/thing"]);
    expect(packageCompletionsFor(installed, "@types").map((p) => p.name)).toEqual([]);
  });

  // Would fail if the slash in a scoped name were treated as a subpath separator and suppressed.
  test("a scoped package completes from its scope prefix", () => {
    expect(packageCompletionsFor(installed, "@sc").map((p) => p.name)).toEqual(["@scope/thing"]);
    expect(packageCompletionsFor(installed, "@scope/th").map((p) => p.name)).toEqual(["@scope/thing"]);
  });

  // Documents the deliberate subpath skip: the renderer holds no `exports` map, so once the user types past a
  // package name into a subpath there is nothing to offer. Would fail if a bare-name match were offered for
  // `nanoid/no`, which on accept would delete the subpath the user was typing.
  test("offers nothing once the prefix goes past a package name into a subpath", () => {
    expect(packageCompletionsFor(installed, "nanoid/no")).toEqual([]);
  });
});

describe("the registered Monaco provider", () => {
  // Would fail if registered for only "typescript": a .jsx or .js tab's model is the "javascript" language id
  // (monaco-setup.ts languageId()), so the provider would silently never fire there.
  test("registers for both Monaco language ids, covering typescript/tsx and javascript/jsx tabs", () => {
    const fake = fakeMonaco();
    registerImportCompletions(fake.monaco, { installed: () => installed });
    expect(fake.selector()).toEqual(["typescript", "javascript"]);
    // Typing the opening quote (or a scope/subpath slash) should open the list without a further keystroke.
    expect(fake.triggerCharacters()).toEqual(["'", '"', "/"]);
  });

  // Would fail if the provider ignored the trigger boundary and completed inside any string.
  test("suggests inside an import specifier and nothing inside an ordinary string", () => {
    const fake = fakeMonaco();
    registerImportCompletions(fake.monaco, { installed: () => installed });

    const importLine = "import nanoId from 'na'";
    const suggestions = fake.suggest(importLine, caretAfter(importLine, "'na"));
    expect(suggestions.map((s) => s.label)).toEqual(["nanoid"]);

    const stringLine = "const s = 'na'";
    expect(fake.suggest(stringLine, caretAfter(stringLine, "'na"))).toEqual([]);
  });

  // Would fail if `installed` were snapshotted at registration instead of read per call -- the second
  // assertion would still show the first list after a package was installed or removed.
  test("reads the installed list per keystroke, so an install or remove shows up without re-registering", () => {
    let current: InstalledPackage[] = [{ name: "nanoid", version: "6.0.1", latest: null }];
    const fake = fakeMonaco();
    registerImportCompletions(fake.monaco, { installed: () => current });

    const line = "import x from 'n'";
    const column = caretAfter(line, "'n");
    expect(fake.suggest(line, column).map((s) => s.label)).toEqual(["nanoid"]);

    current = [{ name: "nanostores", version: "1.0.0", latest: null }];
    expect(fake.suggest(line, column).map((s) => s.label)).toEqual(["nanostores"]);
  });

  // Would fail if the detail text were hardcoded in the provider instead of coming from strings.ts, or if the
  // item were not a Module-kind suggestion carrying the name as the inserted text.
  test("each suggestion carries the Module kind, the name as insert text and the installed version as detail", () => {
    const fake = fakeMonaco();
    registerImportCompletions(fake.monaco, { installed: () => installed });
    const line = "import nanoId from 'na'";
    const column = caretAfter(line, "'na");
    const [suggestion] = fake.suggest(line, column);
    expect(suggestion).toMatchObject({
      label: "nanoid",
      insertText: "nanoid",
      kind: 8,
      detail: strings.completions.packageDetail("6.0.1"),
      range: { startLineNumber: 1, endLineNumber: 1, startColumn: column - 2, endColumn: column },
    });
    // Pins the literal value, not just its type: sortText must sort before Monaco's word-based buffer
    // suggestions, which are plain identifiers ("name", "namespace", …). A "0" prefix guarantees that
    // lexicographically; asserting the exact string is what would catch a regression to plain `pkg.name`
    // (e.g. "nanoid" sorting after "name") -- the milder, quieter version of the user's reported bug.
    expect(suggestion?.sortText).toBe("0nanoid");
  });

  // Would fail if dispose() did not forward to the Monaco registration -- the leak the brief calls out, where
  // remounting the editor would stack duplicate providers.
  test("dispose() disposes the Monaco registration exactly once", () => {
    const fake = fakeMonaco();
    const registration = registerImportCompletions(fake.monaco, { installed: () => installed });
    expect(fake.disposed()).toBe(0);
    registration.dispose();
    expect(fake.disposed()).toBe(1);
  });
});
