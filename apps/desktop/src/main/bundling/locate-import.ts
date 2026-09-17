export interface ImportLocation {
  line: number;
  column: number;
  lineText: string;
}

/**
 * Finds where `specifier` is actually imported in `source` -- not just where its quoted text first appears
 * anywhere in the file. A plain `source.indexOf` would let an earlier comment (`// see "fs" module docs`) or an
 * unrelated string literal (`const label = "fs";`) win over the real import that follows it (fix round 1, M1:
 * confirmed wrong for both). Instead, the quoted specifier is only accepted as a match when it's the target of an
 * `import ... from`, a bare `import "specifier"`, a dynamic `import(...)`, or a `require(...)` -- covering every
 * shape `Bun.build` can hand a plugin, including one split across lines (`import {...}\nfrom\n"specifier";`,
 * confirmed still locating correctly since `\s+` between the keyword and the quote spans newlines too).
 */
export function locateImport(source: string, specifier: string): ImportLocation | undefined {
  const escaped = specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `(?:\\bfrom\\s+|\\bimport\\s*\\(\\s*|\\brequire\\s*\\(\\s*|\\bimport\\s+)(['"])${escaped}\\1`,
  );
  const match = pattern.exec(source);
  if (!match) return undefined;

  const specifierStart = match.index + match[0].length - 1 - specifier.length;
  const before = source.slice(0, specifierStart);
  const lastNewline = before.lastIndexOf("\n");
  return {
    line: before.split("\n").length,
    column: specifierStart - lastNewline,
    lineText: source.split("\n")[before.split("\n").length - 1] ?? "",
  };
}

export function buildCodeFrame(lineText: string, column: number): string {
  return `${lineText}\n${" ".repeat(Math.max(column - 1, 0))}^`;
}
