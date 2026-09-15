// ESC is built with fromCharCode: Biome's noControlCharactersInRegex rejects a literal escape character in a regex.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g");

/** Removes ANSI color and style sequences from captured tool output. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}
