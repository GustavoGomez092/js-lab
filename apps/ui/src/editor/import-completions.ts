import type { InstalledPackage } from "@jslab/rpc-schema";
import type * as Monaco from "monaco-editor";
import { visibleInstalled } from "../npm/npm-panel";
import { strings } from "../strings";

/**
 * The module specifier the caret sits inside, matched against the text *before* the caret on its own line.
 *
 * Only these four forms are module specifiers, which is what keeps an ordinary string literal (`const s = 'na'`)
 * out: the quote has to be preceded by `from`, a line-leading `import`, `import(` or `require(`. Without that
 * anchor Monaco falls back to word-based suggestions scraped from the buffer, which is the reported bug --
 * `nanoId`, `name`, `namespace`… offered where only a package name is valid.
 *
 * `^[ \t]*import`, never `^\s*import`: `\s` also matches newlines, and `type-feeder.ts` (I-4) already paid for
 * that mistake with quadratic backtracking across blank-line runs. Here the input is a single line, so the risk is
 * only theoretical -- the narrow class is still the right habit.
 */
const SPECIFIER_BEFORE_CARET = /(?:\bfrom\s*|^[ \t]*import\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)(["'])([^"'\n]*)$/;

/** Monaco's two JavaScript-family language ids. `tsx`/`jsx` models carry the JSX-ness in their file extension. */
const LANGUAGE_IDS = ["typescript", "javascript"];

export interface ImportSpecifier {
  /** What the user has typed so far between the opening quote and the caret; "" right after the quote. */
  prefix: string;
  /** 1-based Monaco column of the first prefix character, i.e. just past the opening quote. */
  startColumn: number;
}

/** The specifier prefix at `column` (1-based) on `line`, or null when the caret is not inside a module specifier. */
export function importSpecifierAt(line: string, column: number): ImportSpecifier | null {
  const before = line.slice(0, Math.max(0, column - 1));
  const match = SPECIFIER_BEFORE_CARET.exec(before);
  if (!match) return null;
  const prefix = match[2] ?? "";
  return { prefix, startColumn: column - prefix.length };
}

export interface PackageCompletion {
  name: string;
  /** The version in node_modules, or null when it isn't installed there (`InstalledPackage.version`). */
  version: string | null;
}

/**
 * Installed packages whose name starts with `prefix`, in the order the store holds them.
 *
 * `visibleInstalled(…, false)` is reused rather than re-filtering here, so "which packages does the user think
 * they have" has exactly one definition shared with the NPM sheet. It also drops `@types/*`, which are never
 * written as a module specifier.
 *
 * A prefix that runs past a package name into a subpath (`nanoid/no`) matches nothing and so offers nothing: the
 * renderer holds no `exports` map to enumerate subpaths from. Scoped names need no special case -- the slash in
 * `@scope/thing` is part of the name itself, so `@sc` and `@scope/th` both match by plain prefix.
 */
export function packageCompletionsFor(installed: readonly InstalledPackage[], prefix: string): PackageCompletion[] {
  return visibleInstalled(installed, false)
    .filter((pkg) => pkg.name.startsWith(prefix))
    .map((pkg) => ({ name: pkg.name, version: pkg.version }));
}

/**
 * Offers installed package names inside an import/require specifier, for every language the editor supports.
 *
 * `deps.installed()` is called per keystroke, never snapshotted at registration, so installing or removing a
 * package is reflected without re-registering. The caller owns the returned disposable and must dispose it with
 * the editor -- a registration leaked across remounts would stack duplicate providers.
 */
export function registerImportCompletions(
  monaco: typeof Monaco,
  deps: { installed(): readonly InstalledPackage[] },
): { dispose(): void } {
  const provider = monaco.languages.registerCompletionItemProvider(LANGUAGE_IDS, {
    // So typing the opening quote (or a scope/subpath slash) opens the list without a further keystroke.
    triggerCharacters: ["'", '"', "/"],
    provideCompletionItems: (model, position) => {
      const found = importSpecifierAt(model.getLineContent(position.lineNumber), position.column);
      if (!found) return { suggestions: [] };
      // Replaces exactly what was typed between the quote and the caret, so accepting never duplicates it.
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: found.startColumn,
        endColumn: position.column,
      };
      return {
        suggestions: packageCompletionsFor(deps.installed(), found.prefix).map((pkg) => ({
          label: pkg.name,
          kind: monaco.languages.CompletionItemKind.Module,
          detail: strings.completions.packageDetail(pkg.version),
          insertText: pkg.name,
          // Ranks a real module specifier above Monaco's buffer word-based suggestions, which otherwise bury it.
          sortText: `0${pkg.name}`,
          range,
        })),
      };
    },
  });
  return { dispose: () => provider.dispose() };
}
