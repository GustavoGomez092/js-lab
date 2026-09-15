// prettier 3.8's standalone.d.ts doesn't re-export `Plugin` (only formatWithCursor/format/check/getSupportInfo);
// it lives in the root package's type declarations, so import the type from there and the function from standalone.
import type { Plugin } from "prettier";
import * as babel from "prettier/plugins/babel";
import * as estree from "prettier/plugins/estree";
import * as typescript from "prettier/plugins/typescript";
import { formatWithCursor } from "prettier/standalone";
import type { PrettierFormatOptions } from "./prettier-options";

export type FormatOutcome = { ok: true; formatted: string; cursorOffset: number } | { ok: false; error: string };

const plugins = [babel, estree, typescript] as unknown as Plugin[];

/** Runs Prettier 3 standalone (spec §6.4). Shared by the worker and the unit tests. */
export async function formatCode(
  code: string,
  options: PrettierFormatOptions,
  cursorOffset: number,
): Promise<FormatOutcome> {
  try {
    const result = await formatWithCursor(code, {
      ...options,
      // Fix round 1 (m-2): Prettier's default endOfLine is "lf", which would make every line of a CRLF
      // document differ from the formatted output (even lines that needed no change) and defeat the
      // minimal line-level diff. "auto" keeps the document's own line endings.
      endOfLine: "auto",
      cursorOffset: Math.max(0, Math.min(cursorOffset, code.length)),
      plugins,
    });
    return { ok: true, formatted: result.formatted, cursorOffset: result.cursorOffset };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
