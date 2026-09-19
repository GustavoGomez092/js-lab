import { flattenKeys } from "./check";

export interface WidthViolation {
  key: string;
  width: number;
  budget: number;
}

/**
 * Columns a string occupies: East-Asian Wide and Fullwidth characters take two, combining marks take none,
 * everything else takes one.
 *
 * **This is a proxy and nothing more, and it is worth being exact about what it does not do.** The unit suite
 * runs under happy-dom, which has no layout engine: `getBoundingClientRect()` returns zeros and text is never
 * measured. Nothing in this file can tell you a label fits, and no test here should be read as saying so. What
 * it bounds is translation length, which is deterministic -- it catches the realistic failure, a translation
 * several times the English length dropped into a control that cannot grow, and it cannot catch a subtle one
 * (a slightly-too-wide label, a wrap, a clipped descender).
 *
 * The one real browser measurement JSLab has of CJK expansion is the output filter-chip row, measured in a
 * running app at commit 59a7b62 under ruling R-UI9-COUNTS-1: worst-case CJK with three-digit counts came out
 * about 32% wider with no new wrapping and no truncation. Two things follow. First, the chips are deliberately
 * NOT budgeted here -- their real behaviour is known from a real measurement, which beats a column count, and
 * budgeting them would mean re-litigating a shipped result against a weaker instrument. Second, that 32% is a
 * pixel figure and this is a column figure; they are not the same scale and neither is derived from the other.
 * A CJK label typically doubles in columns while growing far less than double in pixels, so a column budget
 * runs pessimistic for CJK -- which is the safe direction for a cap, and the reason the numbers below are not
 * simply "English plus 32%".
 */
export function displayWidth(text: string): number {
  let width = 0;
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code >= 0x0300 && code <= 0x036f) continue; // combining diacritics
    width += isWide(code) ? 2 : 1;
  }
  return width;
}

function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) || // Hangul Jamo
    (code >= 0x2e80 && code <= 0x303e) || // CJK radicals, Kangxi, CJK symbols
    (code >= 0x3041 && code <= 0x33ff) || // Hiragana, Katakana, Hangul Compatibility, CJK compatibility
    (code >= 0x3400 && code <= 0x4dbf) || // CJK Extension A
    (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified Ideographs
    (code >= 0xa960 && code <= 0xa97f) ||
    (code >= 0xac00 && code <= 0xd7a3) || // Hangul syllables
    (code >= 0xf900 && code <= 0xfaff) || // CJK compatibility ideographs
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) || // Fullwidth forms
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x20000 && code <= 0x3fffd) // CJK Extension B and beyond
  );
}

/**
 * The longest a translation of each width-critical label may be.
 *
 * **These are caps, not measurements.** Calling them "derived from styles.css" would overstate them twice
 * over: eleven of them are macOS *native* menu titles that appear in no stylesheet at all (they are built in
 * `apps/desktop/src/main/menu.ts` and handed to `ApplicationMenu`), and the rest sit in controls whose width
 * depends on a font, a device pixel ratio and a user zoom (`--ui-scale`) that no constant here knows. Each
 * number is instead a judgement, picked so that the shipped English clears it with room and a translation
 * cannot run away unnoticed. The control each one guards, and why the number is where it is:
 *
 * - `menu.*` -- macOS menu-bar sections. They size to content and crowd the menu bar as they grow; 14 columns
 *   leaves the widest shipped translation (`Herramientas`, 12) clearing it, and 16 for the three submenu
 *   titles, which sit inside a panel rather than in the bar.
 * - `settings.tabs.*` -- the Settings window's nav column, a fixed `180px` grid track (styles.css `.settings`)
 *   with `6px 10px` button padding, so roughly 160px of text. All eight tabs, including `keybindings`, which
 *   M5d added after this budget was first drafted.
 * - `settings.restartRequired` -- `.field-note`, an 11px badge sitting to the right of a field label on one
 *   line, so it competes with the label rather than having a box of its own.
 * - `shell.*` -- the visible text in the status bar's `white-space: nowrap` flex row (`.status-bar`, 11.5px,
 *   `16px` gaps): the Safe Mode badge and the layout toggle. The two `<select>` controls beside them are NOT
 *   budgeted: `shell.runtime` and `shell.language` are `aria-label`s on those selects (`StatusBar.tsx`), never
 *   rendered as visible text, so they have no width to constrain and a budget on them would assert nothing.
 * - `settings.options.runtime.*` -- the `<option>` text inside that status-bar select and the matching
 *   Settings enum field; the select sizes to its widest option, so this is the entry that moves the row.
 * - `palette.placeholder` -- the command palette's input, in a panel of `min(520px, 100vw - 32px)` at 15px.
 *
 * A key here that `en.json` does not define would silently check nothing, because `checkWidths` skips keys the
 * table lacks. `test/i18n-width.test.ts` asserts every budgeted key exists, which is what keeps a typo in this
 * map from reading as a passing budget.
 */
export const WIDTH_BUDGETS: Record<string, number> = {
  "menu.file": 14,
  "menu.edit": 14,
  "menu.actions": 14,
  "menu.tools": 14,
  "menu.view._": 14,
  "menu.themes": 14,
  "menu.window": 14,
  "menu.help": 14,
  "menu.runtime": 16,
  "menu.language": 16,
  "menu.layout": 16,
  "settings.tabs.general": 16,
  "settings.tabs.editor": 16,
  "settings.tabs.formatting": 16,
  "settings.tabs.appearance": 16,
  "settings.tabs.keybindings": 16,
  "settings.tabs.npm": 16,
  "settings.tabs.build": 16,
  "settings.tabs.advanced": 16,
  "settings.restartRequired": 22,
  "shell.safeMode": 18,
  "shell.split.horizontal": 18,
  "shell.split.vertical": 18,
  "settings.options.runtime.bun": 26,
  "settings.options.runtime.browser": 26,
  "settings.options.runtime.browser-node": 26,
  "palette.placeholder": 32,
};

/** Only keys this locale actually defines are checked; a missing key falls back to `en`, already in budget. */
export function checkWidths(table: unknown, budgets: Record<string, number>): WidthViolation[] {
  const present = new Set(flattenKeys(table));
  const violations: WidthViolation[] = [];
  for (const [key, budget] of Object.entries(budgets)) {
    if (!present.has(key)) continue;
    const value = valueAt(table, key);
    if (value === null) continue;
    const width = displayWidth(value);
    if (width > budget) violations.push({ key, width, budget });
  }
  return violations.sort((a, b) => a.key.localeCompare(b.key));
}

function valueAt(table: unknown, key: string): string | null {
  let node: unknown = table;
  for (const segment of key.split(".")) {
    if (typeof node !== "object" || node === null) return null;
    node = (node as Record<string, unknown>)[segment];
  }
  return typeof node === "string" ? node : null;
}
